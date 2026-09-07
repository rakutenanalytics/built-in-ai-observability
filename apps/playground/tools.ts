/**
 * Tools for the playground's tool-use mode.
 *
 * Deliberately local and instant: the point is to exercise the tool path of the
 * instrumentation, not to depend on a network that can rate-limit a test run.
 */

export interface PlaygroundTool extends LanguageModelToolDeclaration {
  execute(args: Record<string, unknown>): Promise<unknown>;
}

interface Weather {
  tempC: number;
  conditions: string;
  /** Left null on purpose: Chrome rejects a result holding a null anywhere. */
  advisory: string | null;
}

const WEATHER: Record<string, Weather> = {
  tokyo: { tempC: 24, conditions: "clear", advisory: null },
  kyoto: { tempC: 22, conditions: "light rain", advisory: "Take an umbrella." },
  osaka: { tempC: 26, conditions: "cloudy", advisory: null },
};

const CITY_POPULATION: Record<string, number> = {
  tokyo: 13_960_000,
  kyoto: 1_460_000,
  osaka: 2_750_000,
};

function cityKey(args: Record<string, unknown>): string {
  return String(args.city ?? "").toLowerCase();
}

export const tools: PlaygroundTool[] = [
  {
    name: "get_weather",
    description:
      "Get the current weather for a city. Only Tokyo, Kyoto and Osaka " +
      "are known.",
    inputSchema: {
      type: "object",
      properties: {
        city: {
          type: "string",
          description: 'The city name, for example "Tokyo".',
        },
      },
      required: ["city"],
    },
    execute(args) {
      const weather = WEATHER[cityKey(args)];
      if (!weather) {
        return Promise.reject(
          new Error(`No weather for "${args.city}". Try Tokyo, Kyoto or Osaka.`)
        );
      }
      return Promise.resolve({ city: args.city, ...weather });
    },
  },
  {
    name: "get_population",
    description: "Get the population of a city.",
    inputSchema: {
      type: "object",
      properties: {
        city: {
          type: "string",
          description: 'The city name, for example "Kyoto".',
        },
      },
      required: ["city"],
    },
    execute(args) {
      const people = CITY_POPULATION[cityKey(args)];
      if (people === undefined) {
        return Promise.reject(new Error(`No population for "${args.city}".`));
      }
      return Promise.resolve({ city: args.city, people });
    },
  },
];

export const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

export const TOOL_SYSTEM_PROMPT =
  "You answer questions about cities by calling the tools you have. Call " +
  "every tool you need in one turn, then answer in one short sentence using " +
  "only what the tools returned.";

/**
 * Chrome refuses a tool result containing a JSON null at any depth: the whole
 * turn fails with a misleading serialization error. Strip them instead.
 */
export function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .filter((item) => item !== null && item !== undefined)
      .map(withoutNulls);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== null && item !== undefined)
        .map(([key, item]) => [key, withoutNulls(item)])
    );
  }
  return value;
}

/** The tool interfaces are gated behind the same flag as tool support. */
export function toolUseSupported(): boolean {
  return (
    "LanguageModelToolCall" in globalThis &&
    "LanguageModelToolSuccess" in globalThis &&
    "LanguageModelToolError" in globalThis
  );
}

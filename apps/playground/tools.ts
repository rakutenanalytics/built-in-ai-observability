/**
 * Tools for the playground's tool-use mode.
 *
 * Deliberately local and instant: the point is to exercise the tool path of the
 * instrumentation, not to depend on a network that can rate-limit a test run.
 */

export interface PlaygroundTool extends LanguageModelToolDeclaration {
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

interface Weather {
  /** Left null on purpose: Chrome rejects a result holding a null anywhere. */
  advisory: string | null;
  conditions: string;
  tempC: number;
}

const WEATHER: Record<string, Weather> = {
  kyoto: { advisory: "Take an umbrella.", conditions: "light rain", tempC: 22 },
  osaka: { advisory: null, conditions: "cloudy", tempC: 26 },
  tokyo: { advisory: null, conditions: "clear", tempC: 24 },
};

const CITY_POPULATION: Record<string, number> = {
  kyoto: 1_460_000,
  osaka: 2_750_000,
  tokyo: 13_960_000,
};

function cityKey(args: Record<string, unknown>): string {
  return String(args.city ?? "").toLowerCase();
}

export const tools: PlaygroundTool[] = [
  {
    description:
      "Get the current weather for a city. Only Tokyo, Kyoto and Osaka " +
      "are known.",
    execute(args) {
      const weather = WEATHER[cityKey(args)];
      if (!weather) {
        return Promise.reject(
          new Error(`No weather for "${args.city}". Try Tokyo, Kyoto or Osaka.`)
        );
      }
      return Promise.resolve({ city: args.city, ...weather });
    },
    inputSchema: {
      properties: {
        city: {
          description: 'The city name, for example "Tokyo".',
          type: "string",
        },
      },
      required: ["city"],
      type: "object",
    },
    name: "get_weather",
  },
  {
    description: "Get the population of a city.",
    execute(args) {
      const people = CITY_POPULATION[cityKey(args)];
      if (people === undefined) {
        return Promise.reject(new Error(`No population for "${args.city}".`));
      }
      return Promise.resolve({ city: args.city, people });
    },
    inputSchema: {
      properties: {
        city: {
          description: 'The city name, for example "Kyoto".',
          type: "string",
        },
      },
      required: ["city"],
      type: "object",
    },
    name: "get_population",
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

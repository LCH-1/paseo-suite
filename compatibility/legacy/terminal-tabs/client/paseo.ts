export type PaseoApi = ReturnType<typeof import("@getpaseo/plugin/client").getPaseoClient>;
export type PaseoAgent = Awaited<ReturnType<PaseoApi["agents"]["list"]>>["entries"][number]["agent"];
type Timeline = ReturnType<PaseoApi["agents"]["ref"]>["timeline"];
export type PaseoAgentTimelineEvent = Parameters<Parameters<Timeline["subscribe"]>[0]>[0];

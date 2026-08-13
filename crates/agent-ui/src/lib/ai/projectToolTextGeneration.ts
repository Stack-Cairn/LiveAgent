export type ProjectToolTextGenerationRequest = {
  systemPrompt: string;
  userPrompt: string;
  output: "text" | "json";
  signal?: AbortSignal;
};

export type ProjectToolTextGenerationStatus = "ready" | "unconfigured";

export type ProjectToolTextGenerationClient = {
  generate(request: ProjectToolTextGenerationRequest): Promise<string>;
  // Optional readiness probe: "unconfigured" means the host has the
  // capability but no usable model yet, so generation affordances render
  // disabled with a hint instead of failing on click.
  status?(): ProjectToolTextGenerationStatus;
};

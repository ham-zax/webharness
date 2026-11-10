// Default cap on the output a single exec/bash result returns to the model.
// Every result stays in conversation context and is re-billed on each later turn,
// so keep it small (about 4k tokens). Capped results keep a head and tail, report
// the omitted byte count, and retain the complete output at full_output_path.
// Override with MCP_DEV_MAX_OUTPUT_BYTES when a deployment needs more.
export const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024;

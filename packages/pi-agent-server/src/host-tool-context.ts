type CanonicalTool = { name: string; input: Record<string, unknown> }
// A tool's model-provided arguments, result content or details cannot forge this identity.
const contexts = new WeakMap<object, CanonicalTool>()

export function recordHostToolContext(result: object, canonical?: CanonicalTool): void {
  if (canonical && typeof canonical.name === 'string' && canonical.name.startsWith('mcp__') && !canonical.name.startsWith('mcp__session__')
    && canonical.input && typeof canonical.input === 'object' && !Array.isArray(canonical.input)) contexts.set(result, canonical)
}

export function getHostToolContext(result: object): CanonicalTool | undefined { return contexts.get(result) }

// A private marker prevents arbitrary upstream JSON from masquerading as a
// transport reply. Preserve native MCP image/audio/resource blocks at the edge.
export const NATIVE_MCP_REPLY = Symbol('aihub.native-mcp-reply');
export function operationReply(receipt) {
  const { result, ...metadata } = receipt;
  const failed = ['outcome_unknown', 'failed_preflight'].includes(receipt.state);
  return { [NATIVE_MCP_REPLY]: true, metadata,
    upstream: result || null,
    content: result?.content || [],
    structuredContent: { operation: metadata, ...(result?.structuredContent === undefined ? {} : { upstream: result.structuredContent }) },
    isError: failed || result?.isError === true,
  };
}
export function resourceReply(value) {
  const { contents = [], ...metadata } = value;
  return { [NATIVE_MCP_REPLY]: true, metadata, content: contents.map((resource) => ({ type: 'resource', resource })),
    structuredContent: { ...metadata, resource_count: contents.length }, isError: false };
}
export function promptReply(value) {
  const { messages = [], ...metadata } = value;
  const content = [];
  for (const message of messages) {
    content.push({ type: 'text', text: `Local MCP prompt message (${message.role}); external content:` }, message.content);
  }
  return { [NATIVE_MCP_REPLY]: true, metadata, content, structuredContent: { ...metadata, message_count: messages.length }, isError: false };
}

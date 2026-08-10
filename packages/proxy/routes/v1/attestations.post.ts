import { handleAttestationRequest } from "@m365-copilot/proxy-lib";

function isLoopback(address: string | undefined): boolean {
  return address === "::1" || address?.startsWith("127.") === true || address?.startsWith("::ffff:127.") === true;
}

export default defineEventHandler(async (event) => {
  const loopback = isLoopback(event.node?.req.socket.remoteAddress);
  if (!loopback) return handleAttestationRequest(null, undefined, false);

  let body: unknown;
  try {
    body = await readBody(event);
  } catch {
    body = null;
  }
  return handleAttestationRequest(
    body,
    getHeader(event, "x-m365-attestation-sig") ?? undefined,
    true,
  );
});

export interface CoworkSocketPacket {
  type: number;
  id: string;
  endpoint: string;
  data: string;
}

export function decodeSocketPacket(frame: string): CoworkSocketPacket {
  const match = frame.match(/^(\d+):([^:]*):([^:]*):([\s\S]*)$/);
  if (!match) throw new Error(`Invalid Socket.IO frame: ${frame.slice(0, 80)}`);
  return { type: Number(match[1]), id: match[2], endpoint: match[3], data: match[4] };
}

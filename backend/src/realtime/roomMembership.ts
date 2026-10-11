/**
 * The room membership guard relays share: the sender must be an ACTIVE member
 * of the room it names. Same rule as MatchService.activeRoom (chat, typing,
 * rtc:signal), kept apart so feature modules do not reach into the matcher.
 * Read-only, so no store lock is needed.
 */
import type { MatchStore, Room } from "../store/MatchStore";

export interface ActiveMember {
  room: Room;
  /** The sender's slot in room.members. */
  index: 0 | 1;
  /** Socket id of the other member. */
  partner: string;
}

export async function activeMember(store: MatchStore, socketId: string, roomId: string): Promise<ActiveMember | null> {
  const session = await store.getSession(socketId);
  if (!session || session.state !== "active" || session.roomId !== roomId) return null;
  const room = await store.getRoom(roomId);
  if (!room || room.state !== "active") return null;
  const index = room.members.indexOf(socketId);
  if (index < 0) return null;
  return { room, index: index as 0 | 1, partner: room.members[1 - index]! };
}

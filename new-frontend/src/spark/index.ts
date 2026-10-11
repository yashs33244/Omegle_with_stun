/**
 * Spark: one icebreaker both sides of a call see at the same moment.
 *
 * Mount contract (Room.tsx):
 *   const spark = useSpark({ signaling, roomId: callRoomId });   // once per room screen
 *   <SparkButton spark={spark} />                                 // in the call action bar
 *   <SparkCard spark={spark} />                                   // once, near the room root
 *
 * Props are documented in each component's file header. Strings live in the
 * `spark` i18n namespace; prompt texts come from public/spark/prompts.<lang>.json.
 */
export { SparkButton, type SparkButtonProps } from "./SparkButton";
export { SparkCard, type SparkCardProps } from "./SparkCard";
export { useSpark, type SparkHandle, type UseSparkOptions } from "./useSpark";

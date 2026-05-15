/**
 * Default group when none is specified. Projects without an explicit group
 * land here and share one Qdrant collection (`paparats_default`). The point
 * is that "group" is a multi-project bucket — picking the project's own name
 * as a fallback would defeat that and silo every project in its own
 * collection.
 */
export const DEFAULT_GROUP = 'default';

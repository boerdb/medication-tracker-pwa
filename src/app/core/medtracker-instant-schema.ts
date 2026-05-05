import { i } from '@instantdb/core';

export const medtrackerInstantSchema = i.schema({
  entities: {
    $users: i.entity({
      email: i.string().optional().unique().indexed(),
    }),
    medications: i.entity({
      name: i.string(),
      times: i.json<string[]>(),
      stockCount: i.json<number | null>(),
    }),
    logEntries: i.entity({
      medicationId: i.string(),
      medicationName: i.string(),
      dateKey: i.string(),
      time: i.string(),
      status: i.string(),
      updatedAt: i.string(),
    }),
  },
  links: {
    medicationOwner: {
      forward: { on: 'medications', has: 'one', label: 'owner', required: false },
      reverse: { on: '$users', has: 'many', label: 'medications' },
    },
    logEntryOwner: {
      forward: { on: 'logEntries', has: 'one', label: 'owner', required: false },
      reverse: { on: '$users', has: 'many', label: 'logEntries' },
    },
  },
});

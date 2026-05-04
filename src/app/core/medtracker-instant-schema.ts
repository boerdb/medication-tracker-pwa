import { i } from '@instantdb/core';

export const medtrackerInstantSchema = i.schema({
  entities: {
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
});

/**
 * Rechten voor gast- en andere ingelogde gebruikers (auth.id is gezet na signInAsGuest).
 * @see https://www.instantdb.com/docs/permissions
 */
import type { InstantRules } from '@instantdb/core';
import { medtrackerInstantSchema } from './src/app/core/medtracker-instant-schema';

type Schema = typeof medtrackerInstantSchema;

const rules = {
  medications: {
    allow: {
      view: 'true',
      create: 'auth.id != null',
      update: 'auth.id != null',
      delete: 'auth.id != null',
    },
  },
  logEntries: {
    allow: {
      view: 'true',
      create: 'auth.id != null',
      update: 'auth.id != null',
      delete: 'auth.id != null',
    },
  },
} satisfies InstantRules<Schema>;

export default rules;

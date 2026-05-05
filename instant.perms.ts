/**
 * Rechten: elke gebruiker ziet en wijzigt alleen medicatie en logs met dezelfde `owner` ($users) als `auth.id`.
 * @see https://www.instantdb.com/docs/permissions
 */
import type { InstantRules } from '@instantdb/core';
import { medtrackerInstantSchema } from './src/app/core/medtracker-instant-schema';

type Schema = typeof medtrackerInstantSchema;

/**
 * `data.ref("owner.id")` is in de rule engine een lijst — gebruik `in`, niet `==`,
 * en `size(...) == 0` i.p.v. `== null` (anders: overload '_==_' list vs null).
 *
 * De app gebruikt overal `tx.*[id].update({ ... }).link({ owner })` — ook voor nieuwe ids.
 * Dat zijn **update**-checks, geen aparte create: oude regels faalden omdat
 * `auth.id in data.ref("owner.id")` op een nog niet-gelinkte rij false is.
 *
 * Belangrijk: `newData.ref(...)` bestaat **niet** in Instant (zie common-mistakes).
 * Een `canUpdate` met `newData.ref("owner.id")` breekt de permissie-evaluatie.
 * @see https://www.instantdb.com/docs/common-mistakes
 */
const canLinkOrCreateOwner =
  'auth.id != null && (size(data.ref("owner.id")) == 0 || auth.id in data.ref("owner.id"))';

const ownerBind = {
  isOwner: 'auth.id != null && auth.id in data.ref("owner.id")',
  canCreate: canLinkOrCreateOwner,
  /** Zelfde als upsert-pad: update op nieuwe id heeft nog geen owner in `data`. */
  canUpdate: canLinkOrCreateOwner,
  canDelete: 'auth.id != null && auth.id in data.ref("owner.id")',
  /** Geen owner nog: lege lijst; anders alleen eigen owner uitbreiden/wijzigen. */
  canLinkOwner: canLinkOrCreateOwner,
} as const;

const rules = {
  $users: {
    allow: {
      view: 'auth.id != null && auth.id == data.id',
      update: 'auth.id != null && auth.id == data.id',
    },
  },
  medications: {
    bind: ownerBind,
    allow: {
      view: 'isOwner',
      create: 'canCreate',
      update: 'canUpdate',
      delete: 'canDelete',
      link: {
        owner: 'canLinkOwner',
      },
    },
  },
  logEntries: {
    bind: ownerBind,
    allow: {
      view: 'isOwner',
      create: 'canCreate',
      update: 'canUpdate',
      delete: 'canDelete',
      link: {
        owner: 'canLinkOwner',
      },
    },
  },
} satisfies InstantRules<Schema>;

export default rules;

// This file can be replaced during build by using the `fileReplacements` array.
// `ng build` replaces `environment.ts` with `environment.prod.ts`.
// The list of file replacements can be found in `angular.json`.

export const environment = {
  production: false,
  /** InstantDB App ID (dashboard.instantdb.com). Leeg = alleen lokale opslag. */
  instantAppId: 'c470e575-d873-4a58-830b-8830949f9597',
  /**
   * Zwevend InstantDB-devtools-icoon (data explorer). Zet tijdelijk op true tijdens debug.
   * @see https://www.instantdb.com/docs/devtool
   */
  instantDevtools: false,
};

/*
 * For easier debugging in development mode, you can import the following file
 * to ignore zone related error stack frames such as `zone.run`, `zoneDelegate.invokeTask`.
 *
 * This import should be commented out in production mode because it will have a negative impact
 * on performance if an error is thrown.
 */
// import 'zone.js/plugins/zone-error';  // Included with Angular CLI.

# Today availability controls

The Today page follows the device's current clock and timezone in both languages.
Its date heading, current-day selection, remaining-to-midnight default, and manual
capacity date key use one explicit read context. Changing device timezone or
returning to the page refreshes that context; existing date keys, account planning
timezone preferences, and historical source instants are never migrated.

3-hour and 6-hour shortcuts and custom hours share one row. Valid custom edits save
after 450 ms without a Save button; blur and Enter flush immediately. Blank,
intermediate, and out-of-range inputs do not become zero writes. An explicit zero
is valid. One App-owned queue serializes writes across Today navigation, coalesces
newer intent, and retains error feedback if the user leaves the page. An accepted
write revalidates account, local date and timezone before it starts.

The Settings availability section is removed. Today ignores historical weekly
work-window restrictions, using the current remaining/manual budget while still
respecting real deadlines and fixed events. Stored preferences remain intact;
future-date and external AI planning contracts retain their existing policies.

The topbar capture button displays only +, retains its original localized
accessible name, and keeps a 44px target and the same capture/focus flow. Its
approved visual difference is isolated in the frozen secondary-surface pixel
comparison. On narrow screens, the smaller button may shorten its row; raw
geometry must prove that the header/body displacement is exactly that row-height
delta and the settings button stays horizontally fixed. Only that row minimum
height is temporarily normalized for a second strict pixel comparison, then
restored and verified. Raw and normalized evidence are retained; all other
pixels remain exact.

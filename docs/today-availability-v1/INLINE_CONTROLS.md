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
accessible name, and keeps a 44px target and the same capture/focus flow.
The owner approved this visual change and its natural narrow-screen row-height
reduction. The fixed visual reference advances from `6f537a79` to the actual
reviewed runtime `1ba685209e81d6185456aa4c0eacc1c4e82663c3` after independent
inspection of the original unmodified before/after images. No reference source
or screenshot is transformed to simulate a different product.

Main-page screenshots again require exact full-image PNG hashes, without masks,
pixel tolerances, row normalization or repaint interventions. Existing overflow,
secondary navigation, capture focus, accessible-name and 44px checks remain.
The original evidence is preserved in Actions runs [37504863158](https://github.com/haohongfei2001-png/pjsdas/actions/runs/37504863158)
and [37506483737](https://github.com/haohongfei2001-png/pjsdas/actions/runs/37506483737):
trying to normalize the obsolete header introduced browser edge rasterization
differences, so those experimental comparison helpers were removed rather than
relaxing the pixel threshold or changing application behavior.

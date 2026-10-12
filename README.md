# SR6 Edge Qualities

A small Foundry VTT module for the [Shadowrun 6th Edition (Eden)](https://github.com/yjeroen/foundry-shadowrun6-eden) system. It adds the Edge gain of two qualities:

- **Analytical Mind**: +1 Edge on tests that use Logic.
- **Attribute Mastery**: +1 Edge on tests that use the attribute chosen for that quality (set with the gear button on the actor sheet's quality row; the quality is renamed "Attribute Mastery (Logic)" and so on).

The module shows the bonus in Eden's roll dialog, awards the Edge when the roll is made (within the per-round cap and the maximum of 7), posts a chat card for the award or for why none was given, and names the quality on the roll card. It also keeps a small compendium with the two quality items.

## Requirements

- Foundry VTT 13 or 14 (`minimum` 13, verified on 14.369 once the live checks in the rehearsal have passed).
- The `shadowrun6-eden` system: 3.3.9, or 4.x (tested against main `0d81a51`).

## Install

This repository is private and the module is not listed in Foundry's registry. Install by copying the folder into `Data/modules/sr6-edge-qualities` of the Foundry data folder (stop Foundry first, keep the old folder somewhere outside `Data`), then enable it in the world.

## Known limits

- The "configure attribute" button is added to Application v1 actor sheets (Eden's Player and NPC sheets). Eden's Application v2 sheets (Critter, Sprite, Host) do not fire that hook, so they have no button; the Edge award itself works for them (it writes `system.edge.current`). A V2 sheet hook is a possible later change.
- The roll-dialog patch relies on Eden's `RollDialog` keeping `actor`, `prepared`, `dialogResult`, `_onCalcEdge` and `_onAttribChange`. It is an Application v1 dialog, which Foundry 14 deprecates (removal in 16).
- Not tested on a live Foundry 14 world by the author of this change; see the checks listed in the project plan.

## Licence

See `LICENSE`. In short: the code is JC's, the Shadowrun game content is not licensed by JC, the module is for private use and is not meant for public listing.

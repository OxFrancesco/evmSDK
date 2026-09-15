# evmSDK landing page

Static homepage for https://evm.buddytools.org. No wallet connection, no video, no third-party scripts. It is the evmSDK twin of the Aero CLI page in `packages/sugar/site` and reuses that page's claymorphic recipe (rounded surfaces, inset highlights, soft shadows, animated bento grid with hover popups) with a sea-glass teal palette so the two products are visibly siblings without being confused for each other.

A Dark Reader lock preserves the authored colors. Body text is selectable, links and popup triggers have visible keyboard focus, and motion respects reduced-motion preferences.

The capability tiles follow the command table in `packages/evm/README.md`. Keep the tiles honest: every command name on the page exists in the catalog, quantities are described as decimal strings, `--yolo` is described as skipping only the toolkit approval prompt, and Crossmint and wallet-batch limits are stated where the EOA policy story would otherwise imply coverage. The JSON session in the "Made for agents" section is illustrative; ids and hashes are truncated placeholders, not real operations.

`public/evm-hero.svg` is a placeholder illustration. Replace it with a Blender render (transparent PNG, square, 1200 by 1200) and update the `<img>` `src`, `width`, `height` and `alt` in `index.html`. The Aero page's `artwork/render.py` is the starting point for a matching clay scene.

`public/page-preview.png` is referenced by the Open Graph and X card metadata. Capture a 1200 by 860 browser screenshot after the hero art lands and recapture it after substantial changes.

Deploy from the BeeGreat repository root:

```sh
bunx wrangler deploy --config packages/evm/site/wrangler.jsonc
```

The configuration pins Francesco's personal Cloudflare account. The exact hostname route takes precedence over the zone's wildcard BuddyBox route. Keep both the custom domain and the exact route.

No mobile, web chat, iMessage, CLI, provider, or backend behavior changes with this site. The only deploy target is the `evm-sdk-site` Cloudflare worker.

This is an independent project and is not affiliated with, endorsed by, sponsored by, or maintained by Aerodrome Finance, Velodrome Finance, Dromos Labs, or Mellow Protocol. References to their names and protocols describe compatibility or source attribution only. All trademarks belong to their respective owners. Third-party code remains subject to its applicable licenses.

# assets/audio

Optional audio the site serves from `/audio/…`.

## Wrapped music bed

There are three ways the deck gets a soundtrack, tried in this order:

1. **Dashboard upload (preferred).** Dashboard > Wrapped > Music lets an admin
   upload a no-copyright track (or paste an https URL to one). The file is
   stored on Cloudinary and its URL kept in `wrappedSettings.musicUrl`, so it
   survives redeploys on an ephemeral host (unlike a file dropped here).
2. **On-disk file baked into the deploy.** Commit a looping instrumental here:
   - `wrapped-bed.mp3` (preferred) and/or `wrapped-bed.ogg`
3. **Generative bed.** If neither of the above is set, or playback is blocked,
   the deck synthesises a soft ambient bed in the browser, so there is always
   music either way.

`views/wrapped/show.ejs` plays whatever `musicUrl` resolves to (see
`lib/wrapped/pageAssets.js`) on the viewer's first interaction. Keep any file
modest (a minute or two, seamless loop, ~128 kbps is plenty).

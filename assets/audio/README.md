# assets/audio

Optional audio the site serves from `/audio/…`.

## Wrapped music bed

Drop a looping instrumental here to give the Wrapped deck a real soundtrack:

- `wrapped-bed.mp3` (preferred) and/or `wrapped-bed.ogg`

`views/wrapped/show.ejs` tries to play `/audio/wrapped-bed.mp3` (then `.ogg`) on
the viewer's first interaction. If neither file is present or playback is
blocked, it falls back to a generative ambient bed synthesised in the browser —
so the deck always has music either way. Keep the file modest (a minute or two,
seamless loop, ~128 kbps is plenty).

# Attribution

This project reuses **only the core parsing/aggregation library** from
[tokscale](https://github.com/junhoyeo/tokscale) by Junho Yeo.

- Upstream: https://github.com/junhoyeo/tokscale
- Engine crate: `tokscape-core v4.19.1` (pinned, =4.19.1), derived from upstream `tokscale-core`.
- Reused: core library functions for parsing local usage logs and aggregating token/cost stats.
- **Not reused:** upstream TUI code, upstream frontend code, submit/leaderboard/telemetry modules.
  Those are intentionally excluded to keep this app fully offline/local-first.

## License (MIT)

```
MIT License

Copyright (c) 2025 Junho Yeo

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Upstream license: MIT — see https://github.com/junhoyeo/tokscale/blob/main/LICENSE (retrieved at scaffold time; full text reproduced above).

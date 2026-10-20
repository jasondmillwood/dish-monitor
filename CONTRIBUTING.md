# Contributing

Thanks for helping. Small, focused pull requests are easiest to review.

## Setup
```bash
npm ci
MOCK=1 npm run dev        # API :8787, UI :5173, simulated dishes
npm run typecheck
npm test                  # unit, server (1 and 2 dishes), client, installer
python3 scripts/public-scrub.py --history .
```

## Rules
- **No personal data.** Never commit your `config.json`, dish device ids, real IPs (other than the dish's
  `192.168.100.1`), Wi-Fi names, hostnames, tailnet names, tokens or screenshots of a real setup.
  Use the example values and `MOCK=1`. CI runs `scripts/public-scrub.py` over the tree and history.
- **Read-only towards the dish.** Dish Monitor only reads status/history. Don't add calls that change dish settings.
- **1 or 2 dishes.** Keep both setups working and tested.
- **No new root steps in the installer.** Print them for the user instead.
- New dependencies must be permissively licensed (MIT/ISC/BSD/Apache-2.0); run
  `node scripts/third-party-licenses.cjs` and commit the updated `THIRD_PARTY_LICENSES`.
- By contributing you agree your contribution is licensed under the MIT License.

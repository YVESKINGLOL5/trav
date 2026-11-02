# Travolium: running with cross-device sync

The site now stores its data on a small server instead of in each visitor's
browser, so a user, the admin and every device they sign in from all see the
same accounts, deposits, withdrawals, messages and notifications.

Everything is in three files that must stay in the same folder:

- `trav2.html` the website
- `server.js` the server and API (no packages to install)
- `package.json` start command

## Run it

You need Node.js 18 or newer (https://nodejs.org).

```
node server.js
```

Open http://localhost:3000. Do not open `trav2.html` by double-clicking it:
the page needs the server to load and save data.

### First start: admin account

The first time the server starts it creates the admin account.

- Email: `admin@travolium.rw` (change with `ADMIN_EMAIL`)
- Password: the value of `ADMIN_PASSWORD`. If you do not set it, a random
  password is generated and printed in the terminal **once**. Copy it then.

```
ADMIN_PASSWORD="choose-a-strong-password" node server.js
```

(On Windows PowerShell: `$env:ADMIN_PASSWORD="choose-a-strong-password"; node server.js`)

The admin password is only read the first time. Forgot Password is not
available for the admin account, so to change it later stop the server, delete
the admin record from `data/db.json`, and start again with a new
`ADMIN_PASSWORD`.

## Make it work across devices

`localhost` only works on your own computer. For other devices the server has
to be reachable on the internet (or on your local network):

- **Same Wi-Fi / office network:** run the server on one computer and open
  `http://<that-computer's-IP>:3000` on the other devices.
- **Public website:** deploy the three files to any host that runs Node.js
  (for example Render, Railway, Fly.io or a VPS). Set the start command to
  `node server.js`, set `ADMIN_PASSWORD`, and set `TRUST_PROXY=1` when the host
  puts a proxy in front of your app.
  - Use HTTPS (hosts like the ones above provide it automatically). Without
    HTTPS, passwords and sessions travel unencrypted.
  - **Keep the `data` folder on persistent storage.** Many hosts wipe the disk
    on every deploy unless you attach a volume. Point `DATA_FILE` at the volume,
    for example `DATA_FILE=/var/data/db.json`.

## Settings (environment variables)

| Variable         | Default              | Purpose                                              |
|------------------|----------------------|------------------------------------------------------|
| `PORT`           | `3000`               | Port to listen on                                    |
| `DATA_FILE`      | `./data/db.json`     | Where all data is stored                             |
| `ADMIN_EMAIL`    | `admin@travolium.rw` | Email of the first admin account                     |
| `ADMIN_PASSWORD` | random, printed once | Password of the first admin account                  |
| `TRUST_PROXY`    | off                  | Set to `1` behind a proxy so rate limits see real IPs |

## Backups

All data (accounts, transactions, uploaded screenshots, messages) lives in one
file: `data/db.json`. Copy it regularly to back it up. To move to a new server,
copy the file across.

## How it behaves

- Changes made on one device appear on the others within about 3 seconds,
  without refreshing the page.
- Passwords are stored as salted hashes. Nobody, including the admin, can read
  them, so the admin panel no longer shows a Password column. A password reset
  request is applied when the admin approves it.
- Sign-in attempts, registrations and reset requests are rate limited.
- Sessions last 7 days on the server, but the browser forgets the sign-in when
  the tab is closed.
- If the connection drops, a "Connection lost. Reconnecting..." notice appears
  and the page recovers on its own.

## Data from the old version

The earlier version kept everything inside each browser. That data is not
imported, so accounts created before this change will need to register again.

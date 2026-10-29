# Deploying the dev and test stacks to EC2

One AWS EC2 instance (t4g.large, ARM64, af-south-1 Cape Town) runs three Compose projects:

| Project | What | URL |
|---|---|---|
| `hotel-edge` | Caddy with automatic Let's Encrypt HTTPS for both stacks | ports 80, 443 |
| `hotel-dev` | Full YeaStay stack for internal development | `https://<DEV_DOMAIN>` |
| `hotel-test` | Full YeaStay stack for the customer to test | `https://<TEST_DOMAIN>` |

Each stack has its own PostgreSQL, Redis, secrets and SAP Service Layer mock, so test data never mixes with dev. On each domain, `/api/*` goes to the API, `/pwa/*` to the waiter/housekeeping PWA, and everything else to the back office.

## 1. Launch the instance (AWS console)

1. EC2 → **Launch instance** in region **Africa (Cape Town) af-south-1**.
2. AMI: **Ubuntu Server 24.04 LTS (64-bit Arm)**. Amazon Linux 2023 (arm64) also works.
3. Instance type **t4g.large**. Storage: **40 GiB gp3** (images and two databases).
4. Key pair: create or choose one; keep the `.pem` file.
5. Security group, inbound:
   - SSH 22 from **your own IP only**
   - HTTP 80 and HTTPS 443 from anywhere (Let's Encrypt needs port 80)
6. After launch, **Elastic IPs → Allocate → Associate** with the instance, so the address survives stop/start.

## 2. DNS (optional at first)

With real names, add two `A` records pointing at the Elastic IP, for example `dev.yeastay.example.com` and `test.yeastay.example.com`.

Without DNS, the deploy script uses free `sslip.io` names that resolve to the instance's IP, such as `https://test.13-245-10-20.sslip.io`, and Caddy still gets real certificates for them. You can switch to real names later (step 6).

## 3. Prepare the instance (once)

```bash
ssh -i yeastay.pem ubuntu@<elastic-ip>

# Read-only deploy key so the instance can clone the private repo
ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519 -C yeastay-ec2
cat ~/.ssh/id_ed25519.pub
```

Add that public key in GitHub: **KhatriM90/hotel-app → Settings → Deploy keys → Add deploy key** (leave "Allow write access" off). Then:

```bash
ssh-keyscan github.com >> ~/.ssh/known_hosts
git clone git@github.com:KhatriM90/hotel-app.git ~/hotel-app
cd ~/hotel-app
sudo bash deploy/scripts/bootstrap-ec2.sh     # Docker, Compose, Buildx, 4 GB swap
exit                                          # log out and back in so the docker group applies
```

## 4. Deploy

```bash
ssh -i yeastay.pem ubuntu@<elastic-ip>
cd ~/hotel-app

# First run: Let's Encrypt contact email, plus your domains if you have them
ACME_EMAIL=you@example.com DEV_DOMAIN=dev.yeastay.example.com TEST_DOMAIN=test.yeastay.example.com \
  deploy/scripts/deploy.sh
# ...or without DNS (uses sslip.io names):
ACME_EMAIL=you@example.com deploy/scripts/deploy.sh
```

The first run builds every image (about 10 to 15 minutes on a t4g.large), creates `deploy/env/edge.env`, `dev.env` and `test.env` with random secrets, runs the migrations, seeds the demo users, checks health and HTTPS, and prints each stack's links and seed password. The env files stay on the instance only (they are git-ignored); back them up somewhere safe.

Demo users on both stacks: `admin`, `owner`, `group.accounts` (all properties), `k1.manager`, `k1.reception`, `k1.waiter`, `sw.reception`, `km.reception`. They share the stack's `SEED_PASSWORD`. Each stack has a different password, so give the customer only the test one.

### Demo data (optional)

To fill a stack with demo bookings, guests, folios and POS activity for a walkthrough (see [demo-data.md](demo-data.md)), back up its database first, then run the `demo` profile against the running API:

```bash
S="docker compose -p hotel-test --env-file deploy/env/test.env -f deploy/compose.stack.yaml"
$S exec -T postgres pg_dump -U hotel_owner -Fc hotel > ~/backups/test-before-demo-$(date +%F-%H%M).dump
$S --profile demo run --rm demo
```

It prints one line per scenario. Running it again on the same business date changes nothing.

## 5. Redeploy after changes

```bash
cd ~/hotel-app
DEPLOY_REF=main deploy/scripts/deploy.sh dev     # fetch main, rebuild and restart dev only
DEPLOY_REF=main deploy/scripts/deploy.sh test    # promote to the customer's test stack
```

Data, secrets and certificates are kept across redeploys. New migrations run automatically before the API starts. A stack keeps running whatever it was last built from, so deploying dev from a branch does not change test.

### From GitHub Actions (optional)

The **Deploy** workflow runs the same script over SSH. Add these repository secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `EC2_HOST` | Elastic IP or hostname |
| `EC2_USER` | `ubuntu` (or `ec2-user` on Amazon Linux) |
| `EC2_SSH_KEY` | Private key of a key pair whose public key is in the instance's `~/.ssh/authorized_keys` |
| `EC2_KNOWN_HOSTS` | Output of `ssh-keyscan -t ed25519 <elastic-ip>` |

Then Actions → Deploy → Run workflow, choosing dev, test or all and a ref. To deploy dev on every merge to main, set the repository variable `AUTO_DEPLOY_DEV` to `true`. GitHub's runners connect from changing addresses, so this needs SSH open more widely than "my IP"; key-only login keeps that reasonable, but leave it off if you prefer manual deploys.

## 6. Day-to-day operations

```bash
cd ~/hotel-app
S="docker compose -p hotel-test --env-file deploy/env/test.env -f deploy/compose.stack.yaml"
$S ps                        # status
$S logs -f --tail 100 api    # follow API logs
$S restart api

# Database backup / restore
$S exec -T postgres pg_dump -U hotel_owner -Fc hotel > test-$(date +%F).dump
$S exec -T postgres pg_restore -U hotel_owner -d hotel --clean < test-2026-10-27.dump

# Switch to real domain names: edit deploy/env/edge.env, then
deploy/scripts/deploy.sh edge

# Wipe a stack's data completely (asks nothing, cannot be undone)
$S down -v
```

## Troubleshooting

- **No certificate / browser warning.** `docker logs hotel-edge-caddy-1`. Usually DNS not yet pointing at the instance, or port 80 closed in the security group.
- **API not healthy.** `$S logs migrate api`. A failed migration stops the API from starting; fix and redeploy.
- **Build killed.** Check `free -h`; the bootstrap adds 4 GB swap. Deploy one stack at a time (`deploy.sh dev`, then `deploy.sh test`).
- **"cannot reach the Docker daemon".** Log out and back in after the bootstrap so the docker group applies.

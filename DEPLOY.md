# APEX Registry Server Deployment Guide

## Quick Deploy Options

### Option 1: Railway (Recommended - Easiest)

1. **Create Account**: Go to [railway.app](https://railway.app) and sign up with GitHub

2. **Deploy**:
   - Click "New Project" → "Deploy from GitHub repo"
   - Select your repository
   - Set the root directory to `packages/server`
   - Railway will auto-detect the Dockerfile

3. **Configure Environment Variables**:
   ```
   JWT_SECRET=<generate-a-long-random-string>
   NODE_ENV=production
   ```

4. **Add Volume** (for persistent data):
   - Go to your service → Settings → Volumes
   - Add volume mounted at `/app/data`

5. **Get Your URL**: Railway provides a `*.railway.app` domain automatically

---

### Option 2: Render (Free Tier)

1. **Create Account**: Go to [render.com](https://render.com) and sign up

2. **Deploy with Blueprint**:
   - Click "New" → "Blueprint"
   - Connect your GitHub repo
   - Point to `packages/server/render.yaml`
   - Render will create the service with persistent disk

3. **Or Manual Setup**:
   - Click "New" → "Web Service"
   - Connect repo, set root to `packages/server`
   - Build Command: `npm ci && npm run build`
   - Start Command: `node dist/cli.js`
   - Add a 1GB disk mounted at `/var/data`

4. **Environment Variables**:
   ```
   NODE_ENV=production
   DATABASE_PATH=/var/data/apex.db
   STORAGE_PATH=/var/data/packages
   JWT_SECRET=<click-generate>
   ```

---

### Option 3: Fly.io

1. **Install CLI**:
   ```bash
   # macOS
   brew install flyctl

   # Windows
   powershell -Command "iwr https://fly.io/install.ps1 -useb | iex"
   ```

2. **Login & Deploy**:
   ```bash
   cd packages/server
   fly auth login
   fly launch --name apex-registry
   ```

3. **Create Volume** (for SQLite persistence):
   ```bash
   fly volumes create apex_data --size 1 --region ord
   ```

4. **Update fly.toml** (created by launch):
   ```toml
   [mounts]
     source = "apex_data"
     destination = "/app/data"
   ```

5. **Set Secrets**:
   ```bash
   fly secrets set JWT_SECRET=$(openssl rand -hex 32)
   ```

6. **Deploy**:
   ```bash
   fly deploy
   ```

---

### Option 4: DigitalOcean Droplet (Full Control)

1. **Create Droplet**:
   - Choose Ubuntu 22.04
   - Select $6/mo plan (1GB RAM)
   - Add SSH key

2. **SSH & Setup**:
   ```bash
   ssh root@<your-droplet-ip>

   # Install Docker
   curl -fsSL https://get.docker.com | sh

   # Clone repo
   git clone <your-repo-url>
   cd SuperApp/packages/server

   # Create .env
   cat > .env << EOF
   NODE_ENV=production
   JWT_SECRET=$(openssl rand -hex 32)
   EOF

   # Run
   docker-compose up -d
   ```

3. **Setup Domain** (optional):
   - Point your domain to the Droplet IP
   - Install Caddy or nginx for HTTPS

---

## Local Development

```bash
cd packages/server

# Install dependencies
npm install

# Create .env file
cp .env.example .env
# Edit .env and set JWT_SECRET

# Initialize database
npm run db:migrate

# Seed with test data (optional)
npm run db:seed

# Start dev server
npm run dev
```

Server runs at http://localhost:4000
API docs at http://localhost:4000/docs

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `JWT_SECRET` | Yes | - | Secret for signing JWTs (min 32 chars) |
| `NODE_ENV` | No | development | `development` or `production` |
| `PORT` | No | 4000 | Server port |
| `HOST` | No | 0.0.0.0 | Server host |
| `DATABASE_PATH` | No | ./data/apex.db | SQLite database path |
| `STORAGE_PATH` | No | ./data/packages | Package storage path |
| `LOG_LEVEL` | No | info | Logging level |
| `CORS_ORIGINS` | No | * | Allowed CORS origins |

---

## API Endpoints

Once deployed, your server provides:

### Public (for host apps)
- `GET /api/registry/search` - Search apps
- `GET /api/registry/apps/:appId` - Get app info
- `GET /api/registry/apps/:appId/download` - Download package

### Developer Portal
- `POST /api/auth/register` - Register developer
- `POST /api/auth/login` - Login
- `POST /api/apps` - Create app
- `POST /api/apps/:id/versions` - Upload version

### Docs
- `GET /docs` - Swagger UI

---

## Testing the Deployment

```bash
# Check health
curl https://your-server.com/health

# Search apps
curl https://your-server.com/api/registry/search

# Get categories
curl https://your-server.com/api/registry/categories
```

---

## Connecting Host Apps

Update your host app configuration to point to the registry:

**iOS** (`MiniAppManager.swift`):
```swift
let registryURL = "https://your-server.railway.app"
```

**Android** (`MiniAppManager.kt`):
```kotlin
const val REGISTRY_URL = "https://your-server.railway.app"
```

---

## Publishing Mini-Apps

Once the server is running:

```bash
cd your-mini-app

# Build
apex build

# Publish (coming soon in CLI)
apex publish --registry https://your-server.com
```

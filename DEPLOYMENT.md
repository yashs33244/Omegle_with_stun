# Deployment Guide

This document outlines the CI/CD setup and deployment process for the Omegle clone application.

## Architecture

The application consists of two main services:
- **Backend**: Bun-based Node.js server with Socket.IO
- **Frontend**: React SPA served via Nginx

## Docker Setup

### Backend (Bun)
- Uses `oven/bun:1-alpine` base image
- Builds TypeScript to JavaScript
- Runs on port 3004
- Health check endpoint available

### Frontend (React + Nginx)
- Multi-stage build: Bun for building, Nginx for serving
- Optimized for production with gzip compression
- Runs on port 80
- SPA routing support

## GitHub Actions CI/CD

The deployment pipeline includes:
1. **Test Stage**: Lint, build, and test backend
2. **Build Stage**: Build and push Docker images
3. **Deploy Stage**: Zero-downtime deployment to EC2

## Required GitHub Secrets

Add these secrets to your GitHub repository settings:

### Docker Hub
```
DOCKERHUB_USERNAME=yashs3324
DOCKERHUB_TOKEN=dckr_pat_your_docker_hub_token_here
```

### EC2 Deployment
```
EC2_HOST=your.ec2.instance.ip.address
EC2_USER=ubuntu
EC2_SSH_KEY=-----BEGIN RSA PRIVATE KEY-----
your_private_ssh_key_content_here
-----END RSA PRIVATE KEY-----
```

### Application Configuration
```
REACT_APP_API_URL=https://api.yourdomain.com
JWT_SECRET=your-super-secret-jwt-key-minimum-32-characters
FRONTEND_URL=https://yourdomain.com
```

### Optional Database & Cache
```
DB_URL=postgresql://username:password@host:5432/database
REDIS_URL=redis://host:6379
```

### Optional Deployment Path
```
PROJECT_PATH=Omegle_with_stun
```

## Environment Variables

Create a `.env` file in your project root with these variables:

```bash
# Environment
NODE_ENV=production

# Ports
BACKEND_PORT=3004
FRONTEND_PORT=3000

# URLs
REACT_APP_API_URL=http://localhost:3004
FRONTEND_URL=http://localhost:3000

# Security
JWT_SECRET=your-jwt-secret-here

# Optional: Database
DB_URL=postgresql://user:pass@localhost:5432/db

# Optional: Redis
REDIS_URL=redis://localhost:6379
```

## Local Development

1. **Install dependencies:**
   ```bash
   # Backend
   cd backend && bun install
   
   # Frontend
   cd new-frontend && bun install
   ```

2. **Run with Docker Compose:**
   ```bash
   docker-compose up --build
   ```

3. **Run individually:**
   ```bash
   # Backend
   cd backend && bun run dev
   
   # Frontend
   cd new-frontend && bun run dev
   ```

## Production Deployment

The GitHub Action automatically:
1. Tests the backend code
2. Builds Docker images for both services
3. Pushes images to Docker Hub
4. Deploys to EC2 with zero downtime
5. Verifies deployment health

## Health Checks

Both services include health check endpoints:
- Backend: `http://localhost:3004/health`
- Frontend: `http://localhost:3000/health`

## Security Features

- Non-root users in Docker containers
- Security headers in Nginx
- Environment variable injection (no hardcoded secrets)
- Image vulnerability scanning via Docker Scout
- SSH key-based EC2 access

## Monitoring

After deployment, verify services are running:
```bash
# Check container status
docker ps

# Check logs
docker-compose logs -f backend
docker-compose logs -f frontend

# Health checks
curl http://localhost:3004/health
curl http://localhost:3000/health
```

## Troubleshooting

### Common Issues

1. **Build failures**: Check bun.lock files are committed
2. **Deployment failures**: Verify EC2 SSH access and Docker installation
3. **Health check failures**: Ensure ports are accessible and services are running
4. **Image push failures**: Verify Docker Hub credentials

### Debugging

```bash
# SSH into EC2
ssh -i your-key.pem ubuntu@your-ec2-ip

# Check Docker status
sudo systemctl status docker

# View container logs
docker-compose logs -f

# Restart services
docker-compose restart
```

## Next Steps

Consider adding:
- Database (PostgreSQL/MongoDB)
- Redis for session management
- SSL certificates (Let's Encrypt)
- Load balancer (if scaling)
- Monitoring (Prometheus/Grafana)
- Logging aggregation (ELK stack) 
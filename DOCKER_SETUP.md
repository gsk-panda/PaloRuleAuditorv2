# Docker Setup Guide

This guide explains how to run Palo Alto Panorama Rule Auditor as a self-contained Docker container.

## Prerequisites

- Docker Engine 20.10 or later
- Docker Compose 2.0 or later (optional, for docker-compose usage)

## Quick Start

### Using Docker Compose (Recommended)

1. **Create an environment file** (`.env`), optional:
   ```bash
   PANORAMA_URL=https://panorama.example.com
   PANORAMA_API_KEY=your_panorama_api_key_here
   ```

2. **Start the container**:
   ```bash
   docker-compose up -d
   ```

3. **Access the application**:
   - Open your browser to `http://localhost:3010`
   - The frontend is served from the backend on port 3010

4. **View logs**:
   ```bash
   docker-compose logs -f
   ```

5. **Stop the container**:
   ```bash
   docker-compose down
   ```

### Using Docker Directly

1. **Build the image**:
   ```bash
   docker build -t panoruleauditor:latest .
   ```

2. **Run the container**:
   ```bash
   docker run -d \
     --name panoruleauditor \
     -p 3010:3010 \
     -e PANORAMA_URL=https://panorama.example.com \
     -e PANORAMA_API_KEY=your_panorama_api_key_here \
     --restart unless-stopped \
     panoruleauditor:latest
   ```

3. **Access the application**:
   - Open your browser to `http://localhost:3010`

4. **View logs**:
   ```bash
   docker logs -f panoruleauditor
   ```

5. **Stop the container**:
   ```bash
   docker stop panoruleauditor
   docker rm panoruleauditor
   ```

## Environment Variables

### Required Variables

None of these are strictly required at container startup, but you'll need them for the application to function:

- **PANORAMA_URL**: The HTTPS URL of your Panorama management interface
  - Example: `https://panorama.example.com`
  - Can also be configured via the web UI

- **PANORAMA_API_KEY**: Your Panorama XML API key
  - Generate in Panorama: **Device** → **Setup** → **Management** → **XML API Setup**
  - Can also be configured via the web UI

### Optional Variables

- **PORT**: Backend server port (default: `3010`)
  - Only change if you need a different port
  - Remember to update the port mapping in docker-compose.yml or docker run command

- **NODE_ENV**: Node.js environment (default: `production`)
  - Should remain `production` for Docker deployments

## Configuration Methods

The application supports two methods for configuring Panorama connection:

### Method 1: Environment Variables (Recommended for Docker)

Set environment variables when starting the container. These will be available to the backend but not automatically loaded into the UI. Users can still enter them manually in the web interface.

### Method 2: Web UI Configuration

1. Start the container
2. Open `http://localhost:3010` in your browser
3. Enter Panorama URL and API key in the web interface
4. The configuration is stored in the container's filesystem (`.config` file)

**Note**: Configuration stored via the web UI is ephemeral and will be lost when the container is removed unless you use a volume mount.

## Persistent Configuration (Optional)

To persist configuration across container restarts, you can mount a volume:

### Using Docker Compose

Add a volume to `docker-compose.yml`:

```yaml
services:
  panoruleauditor:
    # ... existing configuration ...
    volumes:
      - ./config:/app/.config
```

### Using Docker Directly

```bash
docker run -d \
  --name panoruleauditor \
  -p 3010:3010 \
  -v $(pwd)/config:/app/.config \
  panoruleauditor:latest
```

Then create a `config` file in your current directory with:

```
PANORAMA_URL="https://panorama.example.com"
PANORAMA_API_KEY="your_panorama_api_key_here"
```

## Custom Port Configuration

To run on a different port (e.g., 8080):

### Docker Compose

1. Update `docker-compose.yml`:
   ```yaml
   ports:
     - "8080:3010"
   environment:
     - PORT=3010
   ```

2. Access at `http://localhost:8080`

### Docker Directly

```bash
docker run -d \
  --name panoruleauditor \
  -p 8080:3010 \
  -e PORT=3010 \
  panoruleauditor:latest
```

## Health Check

The container includes a health check endpoint at `/health`. Docker will automatically monitor container health.

Check health status:
```bash
docker ps
```

Or manually:
```bash
curl http://localhost:3010/health
```

## Troubleshooting

### Container won't start

1. **Check logs**:
   ```bash
   docker logs panoruleauditor
   ```

2. **Verify port availability**:
   ```bash
   netstat -tuln | grep 3010
   # or on Linux
   ss -tuln | grep 3010
   ```

3. **Check Docker resources**:
   ```bash
   docker stats panoruleauditor
   ```

### Application not accessible

1. **Verify container is running**:
   ```bash
   docker ps | grep panoruleauditor
   ```

2. **Check port mapping**:
   ```bash
   docker port panoruleauditor
   ```

3. **Test connectivity**:
   ```bash
   curl http://localhost:3010/health
   ```

### Panorama connection issues

1. **Verify Panorama URL is accessible** from the container:
   ```bash
   docker exec panoruleauditor wget -O- https://panorama.example.com
   ```

2. **Check API key** is valid and has required permissions

3. **Review application logs**:
   ```bash
   docker logs panoruleauditor
   ```

## Updating the Container

### Using Docker Compose

```bash
docker-compose pull
docker-compose up -d
```

### Using Docker Directly

```bash
docker pull panoruleauditor:latest
docker stop panoruleauditor
docker rm panoruleauditor
# Then run with your previous docker run command
```

## Building from Source

If you want to build the image yourself:

```bash
docker build -t panoruleauditor:latest .
```

## Security Considerations

1. **API Keys**: Never commit API keys to version control. Use environment variables or Docker secrets.

2. **Network Access**: Ensure the container can reach your Panorama management interface over HTTPS.

3. **Firewall Rules**: Consider restricting access to port 3010 to authorized networks only.

4. **Container Security**: Run the container as a non-root user (already configured in the Dockerfile).

## Production Deployment

For production deployments:

1. **Use a reverse proxy** (nginx, Traefik, etc.) in front of the container
2. **Enable HTTPS** using the reverse proxy
3. **Set up monitoring** and logging aggregation
4. **Use Docker secrets** or a secrets management system for API keys
5. **Configure resource limits** in docker-compose.yml:
   ```yaml
   deploy:
     resources:
       limits:
         cpus: '1'
         memory: 1G
   ```

## Support

For issues or questions:
- Check the main [README.md](README.md) for application documentation
- Review container logs: `docker logs panoruleauditor`
- Open an issue on GitHub

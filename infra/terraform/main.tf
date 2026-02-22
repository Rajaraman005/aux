# ─── Terraform Configuration ──────────────────────────────────────────────────
# Multi-region GKE cluster with Redis, monitoring, and TURN infrastructure
# Run: terraform init && terraform plan && terraform apply
# ──────────────────────────────────────────────────────────────────────────────

terraform {
  required_version = ">= 1.5.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
  backend "gcs" {
    bucket = "videocall-terraform-state"
    prefix = "prod"
  }
}

# ─── Variables ────────────────────────────────────────────────────────────────
variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "Primary region"
  type        = string
  default     = "us-central1"
}

variable "turn_regions" {
  description = "Regions for TURN server deployment"
  type        = list(string)
  default     = ["us-central1", "europe-west1", "asia-southeast1"]
}

variable "environment" {
  default = "production"
}

# ─── Provider ─────────────────────────────────────────────────────────────────
provider "google" {
  project = var.project_id
  region  = var.region
}

# ─── VPC Network ──────────────────────────────────────────────────────────────
resource "google_compute_network" "videocall_vpc" {
  name                    = "videocall-vpc"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "videocall_subnet" {
  name          = "videocall-subnet"
  ip_cidr_range = "10.0.0.0/20"
  region        = var.region
  network       = google_compute_network.videocall_vpc.id

  secondary_ip_range {
    range_name    = "pod-range"
    ip_cidr_range = "10.1.0.0/16"
  }
  secondary_ip_range {
    range_name    = "svc-range"
    ip_cidr_range = "10.2.0.0/20"
  }
}

# ─── GKE Cluster ──────────────────────────────────────────────────────────────
resource "google_container_cluster" "primary" {
  name     = "videocall-cluster"
  location = var.region

  network    = google_compute_network.videocall_vpc.name
  subnetwork = google_compute_subnetwork.videocall_subnet.name

  # Autopilot mode for auto-scaling
  enable_autopilot = true

  ip_allocation_policy {
    cluster_secondary_range_name  = "pod-range"
    services_secondary_range_name = "svc-range"
  }

  release_channel {
    channel = "REGULAR"
  }

  logging_config {
    enable_components = ["SYSTEM_COMPONENTS", "WORKLOADS"]
  }

  monitoring_config {
    enable_components = ["SYSTEM_COMPONENTS"]
    managed_prometheus {
      enabled = true
    }
  }
}

# ─── Redis (Memorystore) ─────────────────────────────────────────────────────
resource "google_redis_instance" "signaling_redis" {
  name           = "videocall-redis"
  tier           = "STANDARD_HA"  # High Availability with replica
  memory_size_gb = 1
  region         = var.region

  authorized_network = google_compute_network.videocall_vpc.id

  redis_version = "REDIS_7_0"
  display_name  = "VideoCall Signaling Redis"

  redis_configs = {
    maxmemory-policy = "allkeys-lru"
  }

  labels = {
    environment = var.environment
    app         = "videocall"
  }
}

# ─── TURN Server Instances (Multi-Region) ────────────────────────────────────
resource "google_compute_instance" "turn_server" {
  for_each     = toset(var.turn_regions)
  name         = "turn-server-${each.value}"
  machine_type = "e2-medium"
  zone         = "${each.value}-a"

  boot_disk {
    initialize_params {
      image = "cos-cloud/cos-stable"  # Container-Optimized OS
    }
  }

  network_interface {
    network    = google_compute_network.videocall_vpc.name
    subnetwork = google_compute_subnetwork.videocall_subnet.name
    access_config {} # Public IP for TURN relay
  }

  metadata = {
    gce-container-declaration = <<-EOF
      spec:
        containers:
          - name: coturn
            image: coturn/coturn:latest
            ports:
              - containerPort: 3478
                protocol: UDP
              - containerPort: 3478
                protocol: TCP
    EOF
  }

  tags = ["turn-server"]

  labels = {
    app         = "turn"
    environment = var.environment
    region      = each.value
  }
}

# ─── Firewall Rules ──────────────────────────────────────────────────────────
resource "google_compute_firewall" "turn_udp" {
  name    = "allow-turn-udp"
  network = google_compute_network.videocall_vpc.name

  allow {
    protocol = "udp"
    ports    = ["3478", "49152-49200"]
  }

  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["turn-server"]
}

resource "google_compute_firewall" "turn_tcp" {
  name    = "allow-turn-tcp"
  network = google_compute_network.videocall_vpc.name

  allow {
    protocol = "tcp"
    ports    = ["3478", "5349"]
  }

  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["turn-server"]
}

# ─── Outputs ──────────────────────────────────────────────────────────────────
output "gke_cluster_name" {
  value = google_container_cluster.primary.name
}

output "redis_host" {
  value = google_redis_instance.signaling_redis.host
}

output "turn_server_ips" {
  value = { for k, v in google_compute_instance.turn_server : k => v.network_interface[0].access_config[0].nat_ip }
}

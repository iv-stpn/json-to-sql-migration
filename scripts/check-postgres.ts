#!/usr/bin/env bun
import { spawn } from "node:child_process";

type RunCommandOptions = { silent?: boolean };

function runCommand(
	command: string,
	args: string[] = [],
	options: RunCommandOptions = {},
): Promise<{ code: number | null; stdout?: string; stderr?: string }> {
	return new Promise((resolve) => {
		const proc = spawn(command, args, { stdio: options.silent ? "pipe" : "inherit" });

		let stdout = "";
		let stderr = "";

		if (options.silent) {
			proc.stdout?.on("data", (data) => {
				stdout += data.toString();
			});

			proc.stderr?.on("data", (data) => {
				stderr += data.toString();
			});
		}

		proc.on("close", (code) => {
			resolve({ code, stdout: options.silent ? stdout : undefined, stderr: options.silent ? stderr : undefined });
		});
	});
}

async function isDockerAvailable(): Promise<boolean> {
	try {
		const result = await runCommand("docker", ["--version"], { silent: true });
		return result.code === 0;
	} catch {
		return false;
	}
}

async function isDockerComposeAvailable(): Promise<boolean> {
	try {
		const result = await runCommand("docker", ["compose", "version"], { silent: true });
		return result.code === 0;
	} catch {
		return false;
	}
}

async function isPostgresContainerRunning(): Promise<{ isRunning: boolean; containerName?: string }> {
	try {
		// First try to get container status using docker compose
		const result = await runCommand("docker", ["compose", "ps", "postgres", "--format", "json"], { silent: true });

		if (result.code === 0 && result.stdout) {
			const output = result.stdout.trim();
			if (output) {
				try {
					const containerInfo = JSON.parse(output);
					return {
						isRunning: containerInfo.State === "running",
						containerName: containerInfo.Name || "postgres",
					};
				} catch {
					// Fallback: check if output contains "running"
					return {
						isRunning: output.includes("running"),
						containerName: "postgres",
					};
				}
			}
		}

		// Fallback: check all postgres containers
		const fallbackResult = await runCommand("docker", ["ps", "--filter", "name=postgres", "--format", "json"], { silent: true });

		if (fallbackResult.code === 0 && fallbackResult.stdout) {
			const containers = fallbackResult.stdout
				.trim()
				.split("\n")
				.filter((line) => line.trim());

			for (const containerLine of containers) {
				try {
					const container = JSON.parse(containerLine);
					if (container.State === "running") {
						return { isRunning: true, containerName: container.Names };
					}
				} catch {}
			}
		}

		return { isRunning: false };
	} catch {
		return { isRunning: false };
	}
}

async function checkPostgresStatus(): Promise<void> {
	console.log("🔍 Checking Postgres container status...");

	// Check Docker availability
	const dockerAvailable = await isDockerAvailable();
	if (!dockerAvailable) {
		console.error("❌ Docker is not installed or not running.");
		console.error("   Please install Docker and ensure it's running before running tests.");
		console.error("   Visit https://docs.docker.com/get-docker/ for installation instructions.");
		process.exit(1);
	}

	// Check Docker Compose availability
	const composeAvailable = await isDockerComposeAvailable();
	if (!composeAvailable) {
		console.error("❌ Docker Compose is not available.");
		console.error("   Please ensure Docker Compose is installed.");
		process.exit(1);
	}

	// Check if Postgres container is running
	const { isRunning, containerName } = await isPostgresContainerRunning();

	if (!isRunning) {
		console.error("❌ Postgres container is not running.");
		console.error("   Please start the Postgres container before running tests:");
		console.error("   docker compose up -d");
		console.error("");
		console.error("   Or run tests with automatic container startup:");
		console.error("   docker compose up -d && bun test");
		process.exit(1);
	}

	console.log(`✅ Postgres container '${containerName || "postgres"}' is running.`);

	// Additional health check - try to connect to postgres
	try {
		const healthCheck = await runCommand(
			"docker",
			["compose", "exec", "-T", "postgres", "pg_isready", "-U", "testuser", "-d", "json_sql_parser_test"],
			{ silent: true },
		);

		if (healthCheck.code === 0) {
			console.log("✅ Postgres is ready to accept connections.");
		} else {
			console.warn("⚠️  Postgres container is running but may not be ready yet.");
			console.warn("   If tests fail, wait a moment for Postgres to finish initializing.");
		}
	} catch {
		console.warn("⚠️  Could not verify Postgres readiness. Container appears to be running but health check failed.");
	}

	console.log("🚀 Ready to run tests!\n");
}

// Run the check
checkPostgresStatus().catch((error) => {
	console.error("❌ Failed to check Postgres status:", error);
	process.exit(1);
});

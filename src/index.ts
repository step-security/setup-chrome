import fs from "node:fs";
import path from "node:path";
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import axios, { isAxiosError } from "axios";
import { LinuxChannelInstaller } from "./channel_linux";
import { MacOSChannelInstaller } from "./channel_macos";
import { WindowsChannelInstaller } from "./channel_windows";
import { installDependencies } from "./dependencies";
import type { Installer } from "./installer";
import { LatestInstaller } from "./latest_installer";
import { getPlatform, OS, type Platform } from "./platform";
import { SnapshotInstaller } from "./snapshot_installer";
import { parse } from "./version";
import { KnownGoodVersionInstaller } from "./version_installer";

const hasErrorMessage = (e: unknown): e is { message: string | Error } => {
  return typeof e === "object" && e !== null && "message" in e;
};

const getInstaller = (
  platform: Platform,
  version: string,
  { resolveBrowserVersionOnly }: { resolveBrowserVersionOnly: boolean },
) => {
  const spec = parse(version);
  switch (spec.value.type) {
    case "latest":
      return new LatestInstaller(platform);
    case "channel":
      switch (platform.os) {
        case OS.LINUX:
          return new LinuxChannelInstaller(platform);
        case OS.DARWIN:
          return new MacOSChannelInstaller(platform);
        case OS.WINDOWS:
          return new WindowsChannelInstaller(platform);
      }
      break;
    case "snapshot":
      return new SnapshotInstaller(platform);
    case "four-parts":
      return new KnownGoodVersionInstaller(platform, {
        resolveBrowserVersionOnly,
      });
  }
};

const installBrowser = async (installer: Installer, version: string) => {
  const cache = await installer.checkInstalledBrowser(version);
  if (cache) {
    core.info(`Found in cache of chrome ${version} @ ${cache.root}`);
    return path.join(cache.root, cache.bin);
  }

  core.info(`Attempting to download chrome ${version}...`);
  const { archive } = await installer.downloadBrowser(version);

  core.info("Installing chrome...");
  const { root, bin } = await installer.installBrowser(version, archive);

  return path.join(root, bin);
};

const installDriver = async (installer: Installer, version: string) => {
  const cache = await installer.checkInstalledDriver(version);
  if (cache) {
    core.info(`Found in cache of chromedriver ${version} @ ${cache.root}`);
    return path.join(cache.root, cache.bin);
  }

  core.info(`Attempting to download chromedriver ${version}...`);
  const { archive } = await installer.downloadDriver(version);

  core.info("Installing chromedriver...");
  const { root, bin } = await installer.installDriver(version, archive);

  return path.join(root, bin);
};

const testVersion = async (
  platform: Platform,
  bin: string,
): Promise<string> => {
  if (platform.os === OS.WINDOWS) {
    const output = await exec.getExecOutput("powershell", [
      "-Command",
      `(Get-Item (Get-Command '${bin}').Source).VersionInfo.ProductVersion`,
    ]);
    if (output.exitCode !== 0) {
      throw new Error(
        `shell exits with status ${output.exitCode}: ${output.stderr}`,
      );
    }
    return output.stdout.trimStart().trimEnd();
  }

  const output = await exec.getExecOutput(`"${bin}"`, ["--version"], {});
  if (output.exitCode !== 0) {
    throw new Error(
      `${path.basename(bin)} exits with status ${output.exitCode}: ${
        output.stderr
      }`,
    );
  }

  const stdout = output.stdout.trim();
  if (
    !stdout.startsWith("Chromium ") &&
    !stdout.startsWith("Google Chrome for Testing ") &&
    !stdout.startsWith("Google Chrome ") &&
    !stdout.startsWith("ChromeDriver ")
  ) {
    throw new Error(
      `${path.basename(bin)} outputs unexpected results: ${stdout}`,
    );
  }
  const v = stdout
    .replace("Chromium ", "")
    .replace("Google Chrome for Testing ", "")
    .replace("Google Chrome ", "")
    .replace("ChromeDriver ", "")
    .split(" ", 1)[0];
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(v)) {
    throw new Error(`Failed to parse version from: ${stdout}`);
  }
  return v;
};

async function validateSubscription(): Promise<void> {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  let repoPrivate: boolean | undefined;

  if (eventPath && fs.existsSync(eventPath)) {
    const eventData = JSON.parse(fs.readFileSync(eventPath, "utf8"));
    repoPrivate = eventData?.repository?.private;
  }

  const upstream = "browser-actions/setup-chrome";
  const action = process.env.GITHUB_ACTION_REPOSITORY;
  const docsUrl =
    "https://docs.stepsecurity.io/actions/stepsecurity-maintained-actions";

  core.info("");
  core.info("\u001b[1;36mStepSecurity Maintained Action\u001b[0m");
  core.info(`Secure drop-in replacement for ${upstream}`);
  if (repoPrivate === false)
    core.info("\u001b[32m✓ Free for public repositories\u001b[0m");
  core.info(`\u001b[36mLearn more:\u001b[0m ${docsUrl}`);
  core.info("");

  if (repoPrivate === false) return;

  const serverUrl = process.env.GITHUB_SERVER_URL || "https://github.com";
  const body: Record<string, string> = { action: action || "" };
  if (serverUrl !== "https://github.com") body.ghes_server = serverUrl;
  try {
    await axios.post(
      `https://agent.api.stepsecurity.io/v1/github/${process.env.GITHUB_REPOSITORY}/actions/maintained-actions-subscription`,
      body,
      { timeout: 3000 },
    );
  } catch (error) {
    if (isAxiosError(error) && error.response?.status === 403) {
      core.error(
        "\u001b[1;31mThis action requires a StepSecurity subscription for private repositories.\u001b[0m",
      );
      core.error(
        `\u001b[31mLearn how to enable a subscription: ${docsUrl}\u001b[0m`,
      );
      process.exit(1);
    }
    core.info("Timeout or API not reachable. Continuing to next step.");
  }
}

async function run(): Promise<void> {
  await validateSubscription();
  try {
    const version = core.getInput("chrome-version") || "stable";
    const platform = getPlatform();
    const flagInstallDependencies =
      core.getInput("install-dependencies") === "true";
    const flgInstallChromedriver =
      core.getInput("install-chromedriver") === "true";
    const noSudo = core.getInput("no-sudo") === "true";

    if (flagInstallDependencies) {
      core.info("Installing dependencies");
      await installDependencies(platform, { noSudo });
    }

    core.info(`Setup chrome ${version}`);

    const resolveBrowserVersionOnly = !flgInstallChromedriver;
    const installer = getInstaller(platform, version, {
      resolveBrowserVersionOnly,
    });
    const browserBinPath = await installBrowser(installer, version);
    const actualBrowserVersion = await testVersion(platform, browserBinPath);

    core.addPath(path.dirname(browserBinPath));
    core.setOutput("chrome-path", browserBinPath);
    core.setOutput("chrome-version", actualBrowserVersion);
    core.info(`Successfully setup chrome ${actualBrowserVersion}`);

    if (flgInstallChromedriver) {
      core.info(`Setup chromedriver ${version}`);

      const driverBinPath = await installDriver(installer, version);
      const actualDriverVersion = await testVersion(platform, driverBinPath);

      core.addPath(path.dirname(driverBinPath));
      core.setOutput("chromedriver-path", driverBinPath);
      core.setOutput("chromedriver-version", actualDriverVersion);
      core.info(`Successfully setup chromedriver ${actualDriverVersion}`);
    }
  } catch (error) {
    if (hasErrorMessage(error)) {
      core.setFailed(error.message);
    } else {
      core.setFailed(String(error));
    }
  }
}

run();

import * as core from "@actions/core";
import path from "path";
import { Changeset, Config, PackageJSON, VersionType } from "@changesets/types";
import writeChangeset from "@changesets/write";
import * as git from "@changesets/git";
import { getPackages, Package } from "@manypkg/get-packages";
import getChangesets from "@changesets/read";
import { read } from "@changesets/config";

function isListablePackage(config: Config, packageJson: PackageJSON) {
  const packageIgnoredInConfig = config.ignore.includes(packageJson.name);

  if (packageIgnoredInConfig) {
    return false;
  }

  if (!config.privatePackages.version && packageJson.private) {
    return false;
  }

  const hasVersionField = !!packageJson.version;
  return hasVersionField;
}

interface UpdatedDeps {
  dependencyName: string;
  prevVersion: string;
  newVersion: string;
  dependencyType: string;
  packageEcosystem: string;
  updateType: string;
  directory: string;
  targetBranch: string;
  compatScore: number;
  alertState: string;
  ghsaId: string;
  cvss: number;
}

async function run(cwd = process.cwd()): Promise<void> {
  try {
    core.debug(`Running in current working directory: ${cwd}`);

    const metadata: string = process.env.DEPENDABOT_METADATA || "";
    const updatedDeps: UpdatedDeps[] = JSON.parse(metadata);
    if (updatedDeps.length === 0) {
      console.log(
        "Found no dependencies that have been updated so no changelog will be generated."
      );
      return;
    }

    const supportedEcosystem = updatedDeps.every(
      (dep) => dep.packageEcosystem === "npm_and_yarn"
    );
    if (!supportedEcosystem) {
      console.log(
        `Changelogs can only be generated for npm packages. Found: ${updatedDeps[0].packageEcosystem}`
      );
      return;
    }

    const packages = await getPackages(cwd);
    const packageNames = packages.packages.map((pkg) => pkg.packageJson.name);
    core.debug(`Found local npm packages: ${packageNames.join(", ")}`);
    if (packages.packages.length === 0) {
      throw new Error(
        `No packages found. You might have ${packages.tool} workspaces configured but no packages yet?`
      );
    }

    const config = await read(cwd, packages);
    core.debug(`Found changesets config at .changeset/config.json`);

    const baseRef = `origin/${config.baseBranch.replace("origin/", "")}`;
    const changedFiles = await git.getChangedFilesSince({
      cwd,
      ref: baseRef,
    });
    core.debug(`Detected changed files: ${changedFiles.join(", ")}`);

    const hasDirectProdDeps = updatedDeps.some(
      (dep) => dep.dependencyType === "direct:production"
    );
    const changedPackageJson = changedFiles.some((file) =>
      file.endsWith("package.json")
    );
    // Attempt to find the root of the workspace if it's not in the top-level directory from the lockfile if present
    const changedLockfile = changedFiles.filter(
      (file) =>
        !file.startsWith(".changeset/") && !file.endsWith("package.json")
    )[0];
    const lockfileDirectory = changedLockfile
      ? `/${path.dirname(changedLockfile).replace(".", "")}`
      : "/";

    if (!hasDirectProdDeps || !changedPackageJson) {
      if (!hasDirectProdDeps) {
        console.log(
          "No top-level production dependencies where updated, so no changelog will be generated."
        );
        return;
      } else if (!changedPackageJson) {
        console.log(
          "No package.json files where changed, so no changelog will be generated."
        );
      }

      return;
    }

    const updatedDepNames = updatedDeps.map((dep) => dep.dependencyName);
    core.debug(
      `Generating changelogs for updated dependencies: ${updatedDepNames.join(
        ", "
      )}`
    );
    const changedChagesets = await getChangesets(cwd, baseRef);
    const changedSummaries = changedChagesets.map(
      (changeset) => changeset.summary
    );
    if (changedSummaries.length > 0) {
      core.debug(`Found existing changelogs: ${changedSummaries.join(", ")}`);
    }

    const changedPackages = await git.getChangedPackagesSinceRef({
      cwd,
      ref: baseRef,
      changedFilePatterns: config.changedFilePatterns,
    });
    const listableChanges = changedPackages.filter((pkg) =>
      isListablePackage(config, pkg.packageJson)
    );
    const changedPackagesNames = listableChanges.map(
      (pkg) => pkg.packageJson.name
    );
    if (changedPackagesNames.length === 0) {
      console.log(
        "No packages have changed so no changelog will be generated."
      );
      return;
    }
    core.debug(
      `Detected changed packages (since ref: ${
        config.baseBranch
      }): ${changedPackagesNames.join(", ")}`
    );

    const type = process.env.DEFAULT_SEMVER_UPDATE_TYPE || "patch";
    const changes = listableChanges.reduce((map, pkg) => {
      const relativePkgDir = path.relative(cwd, pkg.dir);
      // Dependabot sets the dep.directory to the root of the workspace for monorepos
      const packageDeps = updatedDeps.filter(
        (dep) =>
          dep.directory === `/${relativePkgDir}` ||
          dep.directory === "/" ||
          dep.directory === lockfileDirectory
      );
      if (packageDeps.length === 0) {
        console.log(
          `No dependencies where updated for package ${pkg.packageJson.name} so no changelog will be generated.`
        );
        return map;
      }
      const packages = map.get(packageDeps);
      if (packages) {
        packages.add(pkg);
      } else {
        const packagesSet: Set<Package> = new Set();
        packagesSet.add(pkg);
        map.set(packageDeps, packagesSet);
      }
      return map;
    }, new Map() as Map<UpdatedDeps[], Set<Package>>);

    await Promise.all(
      Array.from(changes).map(async (map) => {
        const [packageDeps, pkgs] = map;
        const packages = Array.from(pkgs);
        const releases = packages.map((pkg) => {
          return {
            name: pkg.packageJson.name,
            type: type as VersionType,
          };
        });
        const pkgNames = packages.map((pkg) => pkg.packageJson.name);
        const packageDepNames = packageDeps.map((dep) => dep.dependencyName);
        core.debug(
          `Detected updated package dependencies for package ${pkgNames.join(
            ", "
          )}: ${packageDepNames.join(", ")}`
        );

        let summary;
        if (packageDeps.length === 1) {
          const dep = packageDeps[0];
          summary = `Bump ${dep["dependencyName"]} from ${dep["prevVersion"]} to ${dep["newVersion"]}`;
        } else {
          const depsSummary = packageDeps
            .map((dep) => {
              const { dependencyName, prevVersion, newVersion } = dep;
              return `- ${dependencyName} from ${prevVersion} to ${newVersion}`;
            })
            .join("\n");
          summary = `Bump dependencies:\n${depsSummary}`;
        }

        if (!changedSummaries.includes(summary)) {
          const newChangeset: Changeset = {
            summary,
            releases,
          };
          console.log(
            `Creating changelog for package(s) ${pkgNames.join(
              ", "
            )} with summary "${summary}".`
          );
          await writeChangeset(newChangeset, cwd);
          core.debug(JSON.stringify(newChangeset));
        } else {
          console.log(
            `Changelog already exists for package(s) ${pkgNames.join(
              ", "
            )} with summary "${summary}".`
          );
        }
      })
    );
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message);
  }
}

run();

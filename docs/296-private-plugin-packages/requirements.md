---
title: Private release packages for plugins
description: Install only released plugin files while keeping the full private repository for development.
---

# Requirements

This is a design proposal. Package sources are not implemented.

## Request and provenance

The user has a private plugin repository with tools for images, models, and
other project assets. The repository also holds large example assets in Git
LFS and other development files. Consumers should download only the files
needed to run the released plugin. Development sessions should still receive
the full repository and its LFS assets. The user proposed a private
npm-compatible registry and asked for a design of the ShipIt changes.

The following outcomes restate that request and the existing plugin contract.
The exact declaration syntax, checksum policy, and first-release limits in
[the plan](./plan.md) are proposed engineering decisions, not extra user demands.

## Outcomes

1. Both the development repository and the released package can remain private.
   Installing a package does not require read access to its source repository.
2. Authors control the release contents. A consumer receives the release files,
   without cloning repository history or fetching omitted examples, LFS objects,
   tests, or debug files.
3. Development sessions retain normal Git and LFS behavior. Authors can still
   use the existing live self-development path without publishing each edit.
4. A project declares a released plugin once. Authorized new and restored
   sessions receive the same selected release without local Git setup steps.
5. Released plugins retain existing services, previews, CLI commands, skills,
   settings, project data access, and per-session runtime state.
6. ShipIt identifies the exact release in use. Installation, rebuild, and update
   cannot silently replace it with different content under the same version.
7. A failed download or activation leaves the project usable and reports the
   cause in ShipIt. A failed update within the same source preserves the last
   complete active generation; changing the source cannot expose the old one
   as if it belonged to the new source.
8. Registry download credentials do not enter plugin code, agent-visible
   files, project commits, or logs. Registry setup is reusable across projects.
9. Existing Git declarations and their branch, pin, and refresh behavior remain
   compatible. Package installation does not change workspace LFS policy.

## Contract extension

The [original plugin requirements](../262-plugins/requirements.md) remain the
contract for Git sources. Their Git-specific language about repository files,
branch updates, commits, and GitHub App authentication does not apply literally
to packages. Package consumers receive release contents and exact package
identity. Registry authentication is separate from Git authentication. The
existing Git path remains available for development against unpublished work.

## Acceptance example

A private repository holds a small runnable tool and a large example directory.
CI publishes an archive that omits the example directory. Two consuming
sessions activate the package and run its CLI and preview against their own
project files. Neither fetches the repository or any example LFS object. A
development session on the private repository can open those examples. After
checkout reclamation, the consuming session restores the same package checksum.


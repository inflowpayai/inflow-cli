---
'@inflowpayai/inflow': minor
---

Publish the npm package as a compatibility notice that points users and agents to the signed native InFlow CLI instead
of running commands or managing credentials.

Check GitHub Releases for advisory signed-binary updates, surface a one-line human notice, return structured
current/latest version metadata to agents, bound release checks to a short deadline, provide Homebrew and hosted
installer upgrade guidance, and send the installed CLI version on InFlow API requests.

Prepare native x64 and ARM64 Windows release payloads for Azure Artifact Signing, sign the executable before building
the MSI, sign the MSI before generating checksums and WinGet manifests, and keep unsigned nonpublishing workflow
validation available without production credentials.

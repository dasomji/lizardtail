# Domain terms

- **Project**: the declarative `lizardtail.project.json` manifest, identified by
  its `project` name; describes services, endpoint routes and optional data resources.
- **Instance**: one managed realization of a project. Its ID hashes the Git common
  directory, project name and instance label. Its registered checkout owns that
  identity; a different checkout cannot silently take it over.
- **Main**: the explicitly registered instance labeled `main`, in a dedicated clean
  checkout of the repository default branch. It holds persistent development data
  and supplies initial copies to features. It is not production.
- **Feature instance**: an instance other than `main`, normally tied to a worktree.
  The default label combines branch/root information; an explicit label can be used.
  Its processes, endpoints and writable data are independent of main.
- **Endpoint**: a named ordered set of HTTP routes to services, with its own origin
  and gateway port. Exposure can be a named Tailscale Service, host HTTPS port or
  loopback-only HTTP for fixtures.
- **Reservation**: persisted service/gateway/external port assignments in the
  registry. They survive stop and finish. While running, gateway socket units
  additionally hold the listening ports even after upstream failure.
- **Owned resource**: a resource whose recorded identity can be checked before
  cleanup: Docker instance labels, recorded route targets, generated bridge units,
  instance-local files or a Tailscale Service ownership marker. A matching name
  alone does not authorize deleting an unrelated resource.

These meanings follow `src/managed/{config,system,cli,runtime,resources,bridge}.ts`.

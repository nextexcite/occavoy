# Implementation documents

The current product baseline is **v0.2**: Hong Kong customers, global destinations, a partner-facing demonstration within one month, an assisted usable product within one to two months, and a bounded commercial experiment within twelve weeks.

| Document                                                            | Use it to answer                                                    |
| ------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [Product requirements](product/prd-v0.2.md)                         | What must the first usable service do?                              |
| [Architecture](architecture.md)                                     | Which component owns each record, action, and failure?              |
| [Twelve-week roadmap](roadmap.md)                                   | What evidence allows the next stage to begin?                       |
| [Development workflow](development.md)                              | How do people and coding agents work together?                      |
| [Stack and runtime ADR](adr/0001-stack-and-runtime.md)              | Why Cloudflare at the edge and Rivet Cloud for execution?           |
| [Records and effects ADR](adr/0002-business-truth-and-effects.md)   | How do commands, approvals, and external results remain consistent? |
| [Global contracts ADR](adr/0003-global-destination-contracts.md)    | How do global destinations work without destination-specific code?  |
| [Storage and tools ADR](adr/0004-storage-and-sandbox-boundaries.md) | How do the storage cap and optional sandboxes work?                 |

## Evidence levels

- **Scaffold:** source and local checks exist.
- **Local proof:** a named scenario ran against the pinned local runtime.
- **Cloud proof:** the scenario ran in the intended cloud deployment, with a recorded build and result.
- **Commercial evidence:** an authorized real service produced a documented outcome.

An ADR can accept a design direction before its implementation is proven. The root README, issue records, and redacted test evidence report what has actually run. These documents contain no customer records, private funding assumptions, or real supplier quotes.

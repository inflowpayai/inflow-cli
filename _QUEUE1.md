# Queue 1 - AEP Agent CLI Integration Design

This is the active working queue for a bounded delivery track. It is separate from any implementation plan and must not
be used as a historical changelog.

## Goal

Design the integration of the published `@aep-foundation/agent` package into `inflow-cli`, including the public CLI
surface, InFlow core boundary, identity-provider configuration, durable identity and credential storage, output
contracts, failure behavior, documentation, tests, and release work required before implementation begins.

Queue type: Research

## Definition Of Done

The queue is complete when the current source-backed behavior is documented, the user has approved the CLI and
credential model, every command has a specified interactive and agent-mode contract, the implementation work is split
into bounded tasks, and the Queue Closure Rules are satisfied.

## Completion State

Current state: Design Complete; implementation and explicitly deferred enhancements remain

Current cursor: 120 Next task: Produce the implementation handoff for the five AEP Service operations

Decision Points:

1. Decision: Stage commands by their actual dependency order after `aep inspect`. Context: The user approved every
   identified Agent-side operation but requires staged delivery. Inspect is stateless and can ship without local AEP
   persistence. Enroll is the first operation that needs a durable Service-scoped Agent identity and therefore
   establishes the storage boundary used by Status, Grant, and Revoke. Examples: Stage 1 can deliver
   `inflow aep inspect <service-url>`. Stage 2 can establish storage and deliver `inflow aep enroll <service-url>`.
   Later stages can add one command or one tightly coupled pair at a time. Contract: Stage 1 is Inspect. Stage 2
   establishes identity storage and Enroll. Continue with Status, Grant, and Revoke. These are the five Service
   operations defined by AEP. Authentication-header generation remains an internal software development kit capability,
   not a CLI command. No Identity, request, headers, or resume command is part of this queue. Tier-aware Approval
   presentation, Seller Service-DID administration, and enterprise secure storage remain separately tracked
   implementation enhancements.

2. Decision: Delegated signing for AEP Enroll reuses the refactored `REGISTER` approval classification. Context:
   `Approval.requesterId` is nullable. The current seller dependency comes from the seller-authenticated
   `/v1/requests/register` creation path and Register notification rendering, not from a non-null approval-table
   constraint. The AEP path is also different from the earlier draft: approval is triggered by the Platform delegated
   `sign` operation when `op` is `ENROLL`, because that is the point where the CLI asks InFlow to authorize and sign the
   assertion used immediately before Service Enroll. The refactor can let `REGISTER` approvals carry a null requester
   when the Service DID is not mapped to InFlow, while rendering the Service identity instead of assuming a Seller.
   Examples: An unregistered Service produces `REGISTER`, `requesterId: null`, and a persisted Service DID used for
   “Register with example.com”. A Service registered on InFlow can resolve that DID to its InFlow requester identifier,
   preserving policy and audit linkage without making registration a prerequisite for AEP. Contract: Refactor Register
   creation, policy matching, notifications, and presentation to support a Service-DID requester with an optional InFlow
   requester identifier. The Service DID remains authoritative. Keep `LOGIN`/Grant as a separate later decision based on
   the actual Grant signing and disclosure requirements.

3. Decision: Optional `platform_context` carries Platform-local delegated-signing context without changing assertion
   semantics. Context: The AEP Platform sign request currently has a closed schema containing only `jti`, `op`,
   `service_did`, and optional `lifetime_seconds`. InFlow needs to return and receive its approval identifier during
   asynchronous Sign. Other Platforms may need their own authorization, hardware custody, or compliance context. This
   context may govern whether a Platform signs, but it must never be copied into or alter the defined client assertion
   claims. Examples: `"platform_context": { "approval_id": "..." }` for InFlow; another Platform could use its own
   fields. Contract: Add optional `platform_context` as a free-form object to the generic Platform sign request. Define
   it as Platform-local authorization/custody input excluded from JWT claim construction and returned assertion
   semantics. The software development kit transports it unchanged. Platform profiles, including InFlow, define its
   members.

4. Revised decision: Bound unfinished AEP signing context to 900 seconds. Context: Pending Approvals are purgeable after
   15 minutes, so requested personal-data context must not remain after the authorization can no longer complete.
   Contract: Delete pending or orphaned AepSignContext no later than 900 seconds after creation. Delete context
   synchronously on controlled cancellation or decline where possible, and delete purgeable contexts before the matching
   bulk Approval deletion. Retain an approved context with its non-purgeable approved Approval for audit and completion
   integrity. SigningAudit remains independently durable.

5. Revised decision: Persist a narrow typed binding in `AepSignContext`. Context: Approval holds the approval envelope
   and UserDetails holds InFlow's approved disclosure categories. AepSignContext must contain only what delegated sign
   needs to prove that `platform_context.approval_id` authorizes this exact AEP request. It must also preserve
   normalized AEP claim names so approved values can be emitted with the correct protocol keys. Examples: Bind Agent
   identity identifier, Service DID, operation, normalized requested AEP claim names, request fingerprint, approvalId,
   created/updated/expiry, and completed-signing state. Do not duplicate userId, requesterId, ApprovalType, display,
   notification type, or UserDetails from Approval. Contract: Persist approvalId, agentIdentityId, Service DID,
   operation, normalized requested AEP claim names, canonical request fingerprint, created/updated/expiry timestamps,
   and completed-signing state. Use a validated converter-backed AEP claim-name collection rather than an arbitrary
   request JSON blob. Recompute and compare the canonical fingerprint on every sign attempt. Do not duplicate userId,
   requesterId, ApprovalType, display, notification type, or UserDetails from Approval.

6. Decision: Create authorization inside Sign and pass InFlow-local input through platform_context. Context:
   AepPlatformController implements the AEP-defined Platform surface. InFlow interprets platform_context during Sign
   without changing client-assertion claims. Examples: The initial generic Sign request carries InFlow's normalized
   requested claim names under platform_context. InFlow creates AepSignContext and final Approval, then returns either
   completed Sign or pending Sign with approval_id and retry guidance. The completion request carries approval_id and
   loads the immutable server-side binding. Contract: The initial Sign request carries normalized requested claims in
   platform_context. InFlow creates AepSignContext plus final REGISTER Approval directly. A pending Sign outcome returns
   platform_context containing the InFlow approval identifier; the CLI polls the existing Approval endpoint and sends
   the returned context on completion.

7. Decision: Generic Platform Sign supports HTTP 202 pending with returned platform_context and retry guidance. Context:
   The current Platform Sign schema has no idempotency_key, the software development kit sends no Idempotency-Key
   header, and the specification defines only the completed response. jti is a JWT replay identifier, not a specified
   HTTP idempotency key. Combining preparation and Sign requires a generic pending response that can return
   Platform-local continuation context. Examples: Initial Sign with idempotency key K1 returns HTTP 202 and
   platform_context containing approval_id. Exact retries with K1 return the same pending result. After approval,
   completion Sign includes returned platform_context and a new idempotency key K2; exact retries with K2 return the
   same completed assertion. Contract: HTTP 202 carries status pending, platform_context, and retry_after_seconds; HTTP
   200 retains the existing completed response. Use a new idempotency key for the completion-stage request because its
   body includes the server-returned continuation context; retries within either stage reuse that stage's key.

8. Decision: Use Idempotency-Key headers holistically across retry-sensitive Platform operations. Context: AEP Service
   lifecycle commands currently duplicate the key in the Idempotency-Key header and request body, requiring equality,
   but the Platform Hosted Identity API is a separate surface. Platform Provision normatively requires body
   idempotency_key. Duplicating the Sign key in both locations adds validation and mismatch failure modes without adding
   semantics if no intermediary depends on the header. Source finding: The broader onboarding design places idempotency
   in the binding: HTTP mandates Idempotency-Key, while MCP/JSON-RPC mandates params.idempotency_key. The current core
   draft explicitly says the optional Enroll body copy exists for bindings or application frameworks that persist
   idempotency metadata with the body. No source-backed rationale was found for Platform Provision making the body field
   normative. Contract: Before the unposted Platform draft is published, remove body idempotency_key from Provision and
   require Idempotency-Key for Provision, delegated Sign, and hosted Verification. Hosted Verification needs safe retry
   because it consumes assertion replay state. List and lifecycle GET calls remain keyless. Lifecycle PATCH remains
   naturally idempotent while it only sets a requested state. A future non-HTTP Platform binding defines its own
   transport location. This does not change the separate core Service-command contract.

9. Decision: Retain Platform idempotency results for at least one hour. Context: The core Service-command draft requires
   at least one hour. Platform Provision creates durable identity, Sign may remain pending through human approval, and
   hosted Verification consumes replay state. A retry after the cache expires can create a second identity, approval,
   assertion, or changed verification result unless durable domain uniqueness independently prevents it. Examples: A
   Sign initiation can remain pending longer than one hour if the user does not approve promptly, but the current InFlow
   pending Approval lifecycle is only 15 minutes. Provision should remain protected by its durable caller/service
   uniqueness even after the cached response expires. Contract: Require at least one hour consistently in the generic
   Platform draft, matching AEP core, while requiring implementations to enforce durable operation invariants beyond
   cache expiry. InFlow may retain records longer according to its session and audit policies without making 24 hours a
   universal interoperability burden.

10. Decision: Scope a shared generic Platform idempotency cache by authenticated principal plus Idempotency-Key.
    Context: A raw key cannot be globally unique across tenants, identities, and endpoints. The store must distinguish
    Provision, Sign initiation, Sign completion, and hosted Verification while detecting changed material input. It must
    not hash Authorization headers or other rotating credentials into the operation fingerprint. Examples: Scope a
    record by authenticated principal plus operation/endpoint plus Idempotency-Key. Fingerprint a canonical
    representation of material path parameters and request body. For Sign, include agent identity path id, jti,
    lifetime, op, service DID, and platform_context; for Verification, include the assertion, op, and Service DID.
    Contract: Lookup by authenticated principal plus Idempotency-Key across Provision, Sign, and hosted Verification.
    Each cache record stores the originating normalized operation, cryptographic hash of canonical material path/body
    input, complete replayable HTTP result, and expiry. Reuse under another operation or changed fingerprint returns
    idempotency_conflict. Exclude authentication credentials, transport-only headers, server-generated timestamps, and
    the Idempotency-Key itself from the fingerprint.

11. Decision: InFlow uses the stable authenticated userId as the shared cache principal. Context: A user may
    authenticate through refreshed tokens, API keys, or different clients. Keying by the presented credential would
    break retries after credential rotation; keying only by a global key would permit cross-tenant collisions. The
    generic Platform draft cannot prescribe InFlow's user model but must require a stable authorization principal scope.
    Examples: InFlow uses the authenticated userId, not the access-token identifier or OAuth client identifier. A
    multi-tenant Platform may use tenantId plus owner/accountId when account identifiers are not globally unique.
    Contract: InFlow keys the shared cache by authenticated userId plus Idempotency-Key. Access tokens, API keys, OAuth
    clients, and token identifiers authenticate the user but do not change the namespace. The generic Platform draft
    describes this as the stable authorized principal, including tenant scope where identifiers are not globally unique.

12. Decision: Pending Sign carries retry timing only in the JSON body. Context: HTTP 202 already communicates pending
    state, and HTTP defines Retry-After for retry timing. The JSON body must carry platform_context so the Agent can
    return the Platform's continuation data. Duplicating retry timing in both a header and body creates the same
    ambiguity rejected for idempotency. Examples: HTTP 202 with Retry-After: 5 and body
    `{ "status": "pending", "platform_context": { ... } }`. Contract: HTTP 202 body contains status pending, required
    platform_context, and retry_after_seconds. Do not send Retry-After for this contract. The software development kit
    reads retry timing directly from the validated response body.

13. Decision: retry_after_seconds is a required positive decimal string on the wire. Context: The Platform draft
    represents bounded numeric protocol values such as lifetime_seconds and page counts as decimal strings. Making retry
    guidance optional forces each caller to invent a polling default, while requiring it gives deterministic behavior.
    Examples: `{ "status": "pending", "platform_context": {...}, "retry_after_seconds": "5" }`. Contract: Follow
    existing AEP-owned numeric conventions. The software development kit validates the wire string and exposes a numeric
    retryAfterSeconds value to callers. Clients do not invent a missing default.

14. Decision: retry_after_seconds allows 1 through 300 seconds. Context: Zero would permit a tight polling loop. An
    unbounded value could cause a generic Agent to wait indefinitely or overflow a runtime timer. The field is polling
    cadence, not the approval expiry or total CLI timeout; callers retain their own overall deadline. Examples: `"5"`
    requests a five-second cadence. A Platform needing long-running approval can continue returning pending while the
    caller polls at that cadence; it does not need a one-hour retry interval. Contract: The schema accepts decimal
    strings from "1" through "300". The software development kit rejects an out-of-range Platform response and never
    clamps it. The range controls cadence only; callers enforce total timeout.

15. Decision: Require an explicit status discriminant on both Sign response variants. Context: The current completed
    Sign response has no status field; completion is inferred from HTTP 200 and the presence of client_assertion. The
    new pending body uses status pending. A symmetric wire union is easier to parse, validate, log, and transport
    through abstractions that do not retain HTTP status, but requiring status completed changes the currently published
    software development kit contract before the Platform draft is posted. Examples: HTTP 200 body starts with
    `"status": "completed"`; HTTP 202 starts with `"status": "pending"`. Contract: HTTP 200 requires status completed
    and the existing assertion fields. HTTP 202 requires status pending, platform_context, and retry_after_seconds. The
    specification, schemas, vectors, and software development kit release change together before the Platform draft is
    posted.

16. Decision: platform_context is optional and present only when it contains data; InFlow completed Sign uses it for
    approved claims. Context: Pending platform_context is a continuation value that lets the Agent complete
    Platform-local authorization. Once an assertion is issued, no continuation is required. Returning InFlow's approval
    identifier after completion may aid diagnostics but also retains and propagates Platform-local correlation data
    beyond its operational need. Examples: Completed can contain only status plus the standard assertion fields, or
    optionally echo final platform_context. Contract: The generic Sign request, pending response, and completed response
    may carry platform_context. Omit the field when the object would be empty. An InFlow pending response includes
    approval_id. An InFlow completed ENROLL Sign response includes approved_claims constructed from AepSignContext's
    exact names and the approved UserDetails.

17. Decision: InFlow uses mutually exclusive initiation and completion platform_context shapes. Context: The first Sign
    call supplies requested claim names and creates AepSignContext plus REGISTER Approval. The pending response returns
    approval_id. After approval, the completion Sign call needs only that server-issued identifier because the session
    already persists the normalized claim binding. Allowing all fields simultaneously creates ambiguous behavior and
    lets a completion request attempt to replace approved claims. Examples: Initiation context
    `{ "claims": { "required": ["email"], "preferred": [], "optional": [] } }`; completion context
    `{ "approval_id": "..." }`. Contract: Presence of approval_id selects completion and forbids claims; absence selects
    initiation and requires the structured claims object. The server loads the stored AepSignContext during completion
    and never accepts client changes to approved disclosure.

18. Decision: Send required, preferred, and optional Inspect claims as a structured tiered object to InFlow. Context:
    The AEP implementer guide resolves claims.required in the typical Enroll sequence. The core privacy section requires
    minimum disclosure. InFlow's current Approval shares the requested UserDetails as one approval; it does not provide
    per-claim selection for preferred or optional claims. Examples: For required email, preferred name, and optional
    physical address, the CLI can request only email; email plus name; or all three. Contract: inflow-cli copies the
    normalized Inspect claims tiers into platform_context.claims without flattening. inflow-server validates and
    persists that tiered structure in AepSignContext, then flattens the currently supported mapping into the existing
    Approval UserDetails set. The existing approval is all-or-nothing for the flattened set. A later approval-system
    refinement consumes the already-tiered API without changing its request shape.

19. Decision: Reject Inspect documents whose claim tiers overlap. Context: The structured request preserves required,
    preferred, and optional arrays. Neither flattening nor choosing a tier silently should repair an ambiguous Service
    advertisement because tier controls future approval and privacy behavior. The best boundary may be the AEP Inspect
    validator rather than InFlow-specific server code. Examples: `email` appears in both required and preferred.
    Contract: Specify required, preferred, and optional as pairwise-disjoint arrays. Enforce this in aep-node Inspect
    validation before the CLI calls the Platform. Do not normalize duplicates or delegate repair to inflow-server.

20. Decision: Keep AEP claim-name aliases and bidirectional category mapping in UserDetail. Context: The normative core
    draft explicitly does not define a complete claim catalog; its concrete example is contact.email. The broader
    onboarding design contains person._, contact._, company.\*, and other namespaces, while InFlow UserDetail exposes
    birthdate, deposit addresses, email, mobile, name, national ID, physical address, and username. Inventing local
    aliases would create non-portable Services; moving every InFlow field into core would over-expand the narrow base
    protocol. Examples: contact.email maps cleanly to EMAIL; contact.mobile maps to MOBILE; person.first_name and
    person.last_name share InFlow's NAME approval category but must emit only the individually requested AEP keys.
    Contract: Add the supported claim-name mapping to UserDetail.java. UserDetail resolves exact AEP claim names to the
    internal approval category and exposes the claim names associated with each category. Do not create a separate
    mapping service or require a Foundation claim-catalog specification for this integration.

21. Decision: Emit only exact claim names originally requested and approved through their mapped UserDetail. Context:
    NAME can authorize person.first_name and person.last_name, and physical-address approval may authorize several
    address-shaped aliases. Emitting every alias associated with an approved category would disclose fields the Service
    did not request. Selecting one canonical alias would fail to honor a different exact requested name. Examples: Only
    person.first_name is requested; Approval authorizes NAME. The Enroll claims object must contain only
    person.first_name, not person.last_name. Contract: Preserve exact tiered request names in AepSignContext. A broad
    approval such as NAME authorizes its mapped requested members, but claim construction iterates the original names
    and emits only those exact keys. UserDetail owns the name/category vocabulary; AepSignContext owns which names were
    requested.

22. Decision: inflow-server owns claim mapping and exact approved-claim construction. Context: ApprovalController
    currently returns generic ApprovedDetails fields such as firstName and lastName. If the CLI converts those fields
    into AEP names, the UserDetail claim mapping is duplicated in TypeScript and can drift. The server has both
    AepSignContext's exact request names and UserDetail's mapping/extraction behavior. Examples: An AEP-backed approved
    REGISTER response can include `approved_claims: { "person.first_name": "Ada" }` while retaining existing
    approvedDetails for non-AEP consumers. Contract: The server receives the structured tiered claim request, resolves
    names through UserDetail, creates the flattened Approval UserDetails, preserves exact names in AepSignContext, and
    later constructs exact approved_claims. inflow-cli does not contain a duplicate mapping table.

23. Decision: The initial delegated Sign call is the server-side claim-mapping endpoint. Context: The combined design
    already sends platform_context.claims to AepPlatformController.sign. That method can validate aliases, persist
    AepSignContext, flatten UserDetails, and create REGISTER Approval before returning pending. A separate mapping
    endpoint would restore the preparation round trip and need its own authentication, idempotency, persistence, and
    response contract. Examples: One-call flow is `sign(claims) -> pending approval`; two-call flow is
    `prepare/resolve(claims) -> token`, then `sign(token) -> pending approval`. Contract: Initial sign validates
    platform_context.claims, resolves exact aliases through UserDetail, persists AepSignContext, flattens mapped
    categories into Approval UserDetails, creates REGISTER Approval, and returns completed or pending. No separate
    preparation or mapping endpoint is introduced.

24. Revised decision: Reject unsupported required claims and silently drop unsupported non-required claims. Context:
    Unsupported required claims make the Service contract unsatisfiable. Preferred and optional claims are not
    prerequisites, and the server—not the CLI—now owns mapping. The pending response can return structured omission
    diagnostics inside InFlow's platform_context alongside approval_id. Examples: required contact.email maps; optional
    urn:example:risk-score does not. Pending context can contain approval_id plus
    `unsupported_claims: { "preferred": [], "optional": ["urn:example:risk-score"] }`. Contract: The API request uses
    tiered List<String> values. Reject before creating AepSignContext or Approval when a required name is unsupported.
    Silently drop unsupported preferred/optional names. After validation, map recognized names to AepClaim and persist
    only bounded AepClaims tiers. No unsupported diagnostics are persisted or returned.

25. Decision: Unsupported required claims return requirements_unmet. Context: AEP core already defines
    requirements_unmet as HTTP 422 for required claims that are missing or invalid. Platform endpoints are instructed to
    reuse core Problem Details codes where semantics match. invalid_request would classify a valid but unsatisfiable
    claim request as malformed; a new unsupported_claim code would duplicate existing semantics. Examples: HTTP 422
    application/problem+json with code requirements_unmet and a tiered unsupported_claims extension containing the exact
    required names. Contract: Return HTTP 422 application/problem+json with code requirements_unmet and exact names
    under unsupported_claims.required. Do not expose user claim values. Exact idempotent retries return the cached same
    error.

26. Corrected decision: The final completed Sign response returns exact approved AEP claims in platform_context.
    Context: The CLI already polls authenticated GET /v1/approvals/{approvalId}. ApprovalResponse currently returns
    approvedDetails for approved identity-type approvals. AepSignContext and UserDetail give the server enough
    information to construct only the exact requested AEP keys. A new endpoint would duplicate approval status and user
    scoping; completed Sign should remain assertion-focused. Contract: The CLI polls the existing Approval endpoint only
    to observe pending/approved/declined state. After approval it calls Sign completion with approval_id. InFlow
    validates the Approval and AepSignContext, issues the assertion, and returns platform_context.approved_claims
    containing only exact requested and approved keys. Do not add approved_claims to ApprovalResponse and do not create
    an AEP-specific polling endpoint.

27. Decision: Completed Sign returns approved claims and omits unsupported non-required diagnostics. the approval
    identifier. Context: The initial pending response does not need to report unsupported non-required claims; final
    Sign loads the immutable typed context by approval identifier. approval_id and completion idempotency state.
    Returning the diagnostics again with approved_claims makes the final result self-contained; omitting them minimizes
    response data but requires local continuation storage. Examples: completed platform_context can contain
    approved_claims plus tiered unsupported_claims. Current contract: Completed platform_context contains
    approved_claims only. Unsupported preferred/optional names are silently dropped during initial server mapping and
    are not persisted or returned.

28. Revised decision: AepSignContext owns approvalId; ApprovalFlags.BIT_AEP indicates the associated context exists.
    Context: Combined Sign creates AepSignContext and final Approval together. Completion starts from approval_id, then
    must load the exact AEP binding. Existing Approval owns nullable foreign keys to PolicySession and
    TransactionSession. AEP needs one session per Approval and must prevent accidental reuse across approvals. Contract:
    AepSignContext has a unique, indexed approvalId, following PolicySession's lookup pattern. Approval adds no nullable
    AEP-context foreign-key column. ApprovalFlags gains BIT_AEP. Completion first loads Approval scoped to userId,
    requires the AEP flag, then loads AepSignContext by approvalId. The flag is a discriminator, not proof: a flagged
    Approval with no session is an internal integrity failure and must never sign. Session and flagged Approval are
    created atomically in one writer transaction.

29. Decision: Accept claim tiers as List<String> on the wire, then persist recognized claims as AepClaim/AepClaims.
    Context: Raw claim strings should be parsed once at the server boundary and represented by typed values internally.
    This follows the existing enum plus EnumListModel collection pattern used by Currency/Currencies and
    UserDetail/UserDetails. Contract: The request model uses List<String> for required, preferred, and optional so
    unsupported required names can be detected. Add AepClaim with exact wire-name parsing and AepClaims with persistence
    conversion. After required validation and non-required filtering, AepSignContext stores AepClaims required,
    preferred, and optional. UserDetail maps to and from AepClaim, not strings. Every Approval created by AEP Sign sets
    ApprovalFlags.BIT_AEP.

30. Decision: The CLI polls the existing generic Approval GET endpoint for status only. Context: Approval polling and
    BIT_AEP are unrelated API concerns. The endpoint gains no AEP-specific fields or response behavior. The CLI reads
    status and ignores unrelated generic ApprovalResponse fields. APPROVED triggers the final Sign call; completed Sign
    returns the assertion and exact approved claims. Contract: BIT_AEP remains an internal Approval discriminator
    indicating that AepSignContext exists. It is used by server-side AEP completion/integrity logic, not exposed to or
    interpreted by the polling client.

31. Decision: Do not persist unsupported claim names. Contract: Unsupported required names fail before persistence.
    Unsupported preferred/optional names are silently dropped. AepSignContext contains only typed AepClaims collections
    recognized by the Platform.

32. Decision: Support the complete initial AepClaim-to-UserDetail mapping. Contract: Add
    PERSON_BIRTHDATE/person.birthdate to BIRTHDATE; FINANCIAL_DEPOSIT_ADDRESSES/financial.deposit_addresses to
    DEPOSIT_ADDRESSES; CONTACT_EMAIL/contact.email to EMAIL; CONTACT_MOBILE/contact.mobile to MOBILE;
    PERSON_FIRST_NAME/person.first_name and PERSON_LAST_NAME/person.last_name to NAME;
    PERSON_NATIONAL_ID/person.national_id to NATIONAL_ID; CONTACT_ADDRESS_PRIMARY/contact.address.primary to
    PHYSICAL_ADDRESS; and PERSON_USERNAME/person.username to USERNAME. Exact requested claims control final emission.

33. Decision: Approval.status owns lifecycle; AepSignContext stores nullable signedAt only. Context: Approval already
    owns pending, approved, declined, cancelled, and terminal lifecycle. Duplicating those states in AepSignContext
    creates synchronization risk. The signing context still needs to record whether its one approved completion has
    issued an assertion so another completion idempotency key cannot sign twice. Examples: Keep Approval.status
    authoritative and store nullable signedAt on AepSignContext. A null signedAt means an approved session has not
    issued; non-null means terminal signing completion. Contract: Do not duplicate pending/approved/declined/cancelled
    status. signedAt records assertion issuance as a separate fact. Persist signedAt with signing audit and completed
    idempotency result as one logical transaction.

34. Decision: Name the signing record AepSignContext. Context: The record no longer represents a separately prepared
    session. It stores the typed claim tiers and binding context connecting initial Sign, Approval, and final Sign.
    Approval owns pending/approved/declined/cancelled state. Contract: Use AepSignContext consistently for entity,
    service, repository, manager, migration, and internal types. The name describes the binding context between initial
    Sign, Approval, and final Sign without implying an independent approval lifecycle.

35. Decision: Use set-based AepSignContext deletion before Approval batch deletion. Context: DeleteApprovalManager
    performs set-based deletes by Approval status and age, so it cannot inspect BIT_AEP row-by-row. Duplicating Approval
    status into the child record solely for cleanup risks drift. Loading and deleting individual Approval entities would
    regress batch performance. Contract: In the same writer transaction, bulk-delete contexts whose approvalId is
    selected by the same Approval status/age predicate, then run the existing Approval bulk delete. Synchronous deletion
    deletes context by approvalId first; a missing child is a no-op. Do not load rows individually or duplicate Approval
    status.

36. Decision: Initial Sign and final Sign are separate completed operations with separate idempotency keys. Contract:
    Once initial Sign returns pending, that request is complete and its key is no longer part of the polling or
    final-Sign discussion. After polling reaches APPROVED, final Sign uses a new unique Idempotency-Key. Network retries
    of final Sign reuse that same key. Successful final Sign sets signedAt and consumes the AepSignContext; no
    additional repeated-issuance workflow is designed.

37. Decision: Final Sign uses state-specific Approval outcomes. Context: The normal CLI calls final Sign only after
    polling sees APPROVED, but status can race or callers can invoke the API directly. The server must fail closed
    without treating approval_id as authorization by itself. Examples: PENDING can remain a 202 pending Sign result;
    DECLINED/CANCELLED are explicit authorization denial; missing, wrong-user, non-AEP, or missing-context records
    remain indistinguishable. Contract: PENDING returns 202 pending with the same approval_id context. APPROVED with
    valid AEP context returns 200 completed. DECLINED/CANCELLED returns 403 authorization_denied. Missing, wrong-user,
    or non-AEP returns 404 not_recognized. BIT_AEP with missing context fails closed as an internal integrity error.

38. Decision: Resolve AEP REGISTER requesterId from a unique Seller.serviceDid column. Context: No current Seller or
    User model stores a Service DID, so inflow-server has no authoritative DID-to-user mapping. Inferring ownership from
    the did:web hostname and Seller website/domain would be unverified and unsafe. AepSignContext already preserves the
    authoritative Service DID for presentation and audit. Contract: Add nullable unique serviceDid with length 256 to
    Seller and exact lookup methods in Seller repositories and service. Initial Sign looks up the validated Service DID;
    a match supplies Seller.sellerId as requesterId, while no match leaves requesterId null and does not block AEP. Do
    not infer from website/hostname. Population and ownership verification are explicitly outside this delivery.

39. Decision: Resolve only APPROVED Sellers by Service DID. Context: SellerStatus has ONBOARDING, REVIEW, and APPROVED.
    Associating an unapproved Seller with an external Service Approval may present an identity that InFlow has not
    accepted yet and may affect requester-scoped Register policy. Examples: A serviceDid match exists on a REVIEW
    Seller. Contract: Seller lookup requires exact serviceDid and SellerStatus.APPROVED. ONBOARDING, REVIEW, or no match
    leaves requesterId null. The authoritative Service DID still drives presentation and AEP continues.

40. Decision: Show mapped Seller.name or fall back to the validated did:web hostname. Context: Existing Register
    notifications dereference Seller.name. AEP permits requesterId null, so presentation must work without Seller. When
    a verified APPROVED Seller mapping exists, its configured name is more human-friendly than a DID, but the Service
    DID remains the authoritative protocol identity. Examples: Mapped `did:web:api.example.com` shows “Register with
    Example, Inc.”; unmapped shows “Register with api.example.com”. The full DID remains available in detail/audit
    views. Contract: Use Seller.name when an approved exact serviceDid mapping exists; otherwise derive the human label
    from the validated did:web host. Preserve the full Service DID as secondary detail/audit data. Never dereference
    Seller unconditionally.

41. Revised decision: A new `inflow aep enroll` never resumes a prior enrollment. Context: MPP and x402 use interval
    default 0, maxAttempts default 0, and timeout default 900. Zero returns pending immediately with a follow-up
    command; a positive interval polls inline. AEP also receives server retry_after_seconds, but no separate AEP
    approval-status command or durable resumable Enroll journal is needed. Contract: Every Enroll invocation starts a
    new logical operation with new idempotency keys and may create a new Approval. It never searches for or consumes a
    prior pending journal entry merely because Service DID and claims match. Interrupted, timed-out, or otherwise
    incomplete attempts are abandoned, local operation state is removed, and later Enroll starts over.

42. Decision: AEP Enroll has no resume command or continuation surface. Contract: Do not add aep resume, enroll
    --resume, nested resume, or Approval-status continuation. A later Enroll is always new. Controlled interruption or
    timeout best-effort cancels an existing Approval, then removes local operation state. Server cleanup removes
    cancelled or crash-abandoned Approval/AepSignContext records.

43. Decision: `inflow aep enroll` polls inline until completion or abandonment. Context: Final Sign and Service Enroll
    run in the CLI. If the command returns while Approval is pending and resume is forbidden, no supported actor remains
    to finish the operation. Therefore MPP/x402's interval=0 nonblocking pattern does not fit this command. Contract:
    Both agent and TTY modes remain in the command until completed, declined/cancelled, timed out, or interrupted. Use
    retry_after_seconds unless --interval overrides it. Keep timeout and max-attempts as interruption bounds. Do not
    expose interval=0 nonblocking behavior. Any non-completed attempt is abandoned and removed as defined above.

44. Decision: Return external Service pending as a valid Enroll outcome. Context: Service enrollment pending occurs
    after InFlow approval and final Sign have completed. It is AEP lifecycle state, not an interrupted Approval
    workflow. Contract: Return pending immediately and preserve the Agent identity. Retain the complete validated
    Service Enroll response only for the current command result; do not persist it. A later AEP Status command fetches
    active or rejected state from the Service. Do not remove identity or treat pending as CLI failure.

45. Revised decision: Preserve the full Service lifecycle response in Enroll agent JSON while keeping Enroll human
    rendering action-oriented and concise. Context: This is command presentation only, not storage. The Service owns
    fetchable enrollment lifecycle state. Locally, the CLI persists only the Service-DID-to-Agent-identity mapping
    needed for later authenticated operations. Enroll response details, approved claims, and Service status remain
    ephemeral. EnrollResponse and StatusResponse already share status, owner_action_required, and requirements_pending;
    Status can additionally contain since. Rationale: The Service's AEP Enroll response should mirror or remain closely
    related to the AEP Status response. Agent-mode CLI JSON preserves that complete validated response because agents
    need the protocol result for subsequent orchestration. Human rendering is a separate presentation contract: Enroll
    is an action and should report its outcome concisely; a human who wants the verbose lifecycle view can run Status.
    Contract: Persist only the canonical Service-DID-to-Agent-identity mapping. Do not persist Enroll response details,
    approved claims, or Service lifecycle status. Enroll reports an action-oriented enrollment status; Status fetches
    and presents the fuller lifecycle response from the Service. Do not conflate the Service response, agent JSON
    projection, and human printable rendering.

46. Decision: Enroll agent JSON returns the complete validated AEP Enroll response. Contract: Do not reduce the agent
    result to status alone and do not invent an InFlow next_action vocabulary. Preserve the full protocol response,
    including lifecycle fields shared with Status and valid extensions. This remains ephemeral command output; only the
    Service-DID-to-Agent-identity mapping is persisted locally.

47. Decision: Platform delegated Sign requires InFlow approval for ENROLL and GRANT only. Contract: ENROLL and GRANT
    Sign requests enter the applicable approval flow before assertion issuance. STATUS and REVOKE Sign requests do not
    create or poll an Approval; after authentication, authorization, request validation, and idempotency checks, the
    Platform signs them directly. Keep the generic AEP Sign wire contract independent from InFlow's operation-specific
    approval policy.

48. Decision: Confirm the remaining Enroll edge contracts. Contract: A valid rejected Service response is a protocol
    outcome. A later Enroll reuses the existing Service Agent identity but never resumes an interrupted operation.
    Enroll agent JSON adds no InFlow envelope or schema_version. Persistence failure after remote Enroll success is
    reported as a distinct partial-success failure. A rejected repeat Enroll does not delete a pre-existing
    Service-to-Agent identity mapping because identity ownership is distinct from cached Service enrollment status.

49. Decision: Status is a read-only Service lifecycle command over an existing local Agent identity. Context: AEP Status
    is authenticated with an assertion whose operation is STATUS. The Service is authoritative for enrollment lifecycle
    state, and the CLI intentionally persists no lifecycle snapshot. Creating an identity while asking for Status would
    make a read command mutate Platform and local state. Contract: `inflow aep status <service-reference>` uses the same
    forgiving Service-origin normalization as Inspect, resolves the canonical Service DID, requires the existing local
    Service-DID-to-Agent-identity mapping, obtains a directly signed STATUS assertion from the Platform without
    Approval, calls the software development kit's Status operation, and returns the complete validated Status response
    in agent JSON. Human output presents the detailed lifecycle view, including status, since, owner action, pending
    requirements, and meaningful recognized extensions. Missing local identity fails before Platform Sign or Service
    Status and does not provision automatically. Status performs no local persistence and preserves valid unknown
    response extensions in agent JSON.

50. Revised decision: Preserve distinct verification and requirement dimensions across Enroll and Status. Context: The
    broader onboarding design distinguishes `verification_pending` from `requirements_pending`. `verification_pending`
    names claims whose asynchronous verification remains incomplete after Enroll and can require Owner action.
    `requirements_pending` names claim categories the Agent still needs to provide because current Service requirements
    are unsatisfied, including requirements introduced after enrollment. Contract: `verification_pending` and
    `requirements_pending` are distinct concepts, not aliases. Both EnrollResponse and StatusResponse may carry both
    optional fields, subject to the response-presence and omission rules decided in the specification design session.
    `owner_action_required` independently indicates an out-of-band Owner step. Correct specifications, schemas,
    examples, AEP Node types/parsers, conformance fixtures, Service models, and tests together.

55a. Decision: Allow both lifecycle dimensions on both Enroll and Status responses. Contract: EnrollResponse and
StatusResponse each permit optional `verification_pending` and `requirements_pending`. Enroll can report submitted
claims awaiting verification and additional requirements known at enrollment time. Status is the canonical polling
surface and reports how both dimensions evolve. Status may also contain `since`; the response types remain closely
related but distinct.

55b. Decision: Omit empty lifecycle arrays. Contract: Include `verification_pending` and `requirements_pending` only
when the respective collection is non-empty. Absence means the corresponding pending set is empty. Parsers may normalize
absence to an empty internal collection; serializers omit empty collections. Consumers accept absent fields and unknown
valid extensions remain preserved.

55c. Decision: Treat owner action as an independent lifecycle signal. Contract: `owner_action_required` states whether
the Owner must currently perform an out-of-band action. It may accompany verification_pending, requirements_pending,
both, or neither. It does not move or classify entries between the arrays. A Service may set it without naming the
underlying item when disclosure would be inappropriate.

55d. Decision: Canonically omit owner_action_required when false. Contract: Serialize `owner_action_required: "true"`
only while Owner action is currently required. Omission means false. Consumers accept explicit `"false"` for
compatibility, but canonical serializers omit it. Parsers may normalize absence to false internally.

55e. Decision: Keep lifecycle fields distinct from blocking Problem Details codes. Contract: Enroll may successfully
return pending lifecycle state, and Status remains callable to observe it. `verification_pending` Problem Details means
another authenticated operation cannot proceed because necessary verification is incomplete. `requirements_unmet` means
required information is missing or invalid. Pending state does not make every operation fail. Revoke remains permitted
for credential invalidation; Grant may be blocked when the condition prevents safe issuance.

55f. Decision: Blocking Problem Details may carry actionable lifecycle extensions. Contract: After the Agent identity is
authenticated and recognized, `verification_pending` errors may include a non-empty verification_pending array and
`requirements_unmet` errors may include a non-empty requirements_pending array. Either may include owner_action_required
only when true. Do not include empty arrays or claim values. Recognition failures remain not_recognized without these
extensions.

56. Decision: Define Sign policy for every current AEP operation and fail closed for unknown operations. Contract:
    INSPECT is unauthenticated and never uses Platform Sign. ENROLL requires REGISTER Approval. GRANT requires an
    approval flow whose user-facing classification is designed with Grant. REVOKE and STATUS are signed directly after
    authentication, authorization, validation, and idempotency processing where applicable. A Platform Sign request
    carrying an operation outside the current authenticated AEP operation set is rejected until an explicit policy is
    registered; it is never signed by default.

57. Revised decision: Bound unfinished AEP signing context to the 900-second Approval lifetime. Context: The existing
    pending Approval purge threshold is 15 minutes. A 24-hour stale-session rule would retain an abandoned
    AepSignContext long after its Approval can be completed and is unnecessary for this combined Sign flow. Contract:
    Pending or orphaned AepSignContext records are cleanup-eligible no later than 900 seconds after creation. Controlled
    cancellation and decline delete the context synchronously where possible. Approved contexts remain with their
    non-purgeable approved Approval for audit and completion integrity. Platform idempotency retention remains at least
    one hour because it is a protocol replay guarantee, not an Approval or signing-context lifetime. Assertion lifetime
    and retry_after_seconds remain capped at 300 seconds; Inspect timeout remains capped at 300 seconds.

58. Decision: Platform delegated `sign(GRANT)` reuses a refactored `LOGIN` Approval classification. Contract: Initial
    GRANT Sign creates LOGIN Approval and sets ApprovalFlags.BIT_AEP. AepSignContext binds the exact Service DID, grant
    type, requested scopes, extension parameters, and optional mapped requesterId. The existing LOGIN policy,
    notification, and presentation paths must support the AEP Service context without assuming an ordinary InFlow login
    request.

59. Decision: Every explicit Grant command starts a fresh credential issuance operation. Contract: A usable stored
    credential does not short-circuit `inflow aep grant`. Each invocation uses new operation idempotency keys, obtains a
    new LOGIN Approval and signed GRANT assertion, and calls the Service Grant endpoint. Existing credentials remain
    stored unless the Service returns the same credential identifier or later lifecycle cleanup or Revoke removes them.

60. Decision: Persist complete validated Service-issued credentials with expiry-aware selection. Context: Service Grant
    returns the actual bearer token, API key, Basic credential, or extension credential. That response is credential
    material the Agent needs for later authentication, not merely display metadata. Contract: Validate the complete
    Grant response and store it locally by canonical Service DID and credentialId with grant type, issuedAt, expiresAt
    when supplied, scopes, and the complete credential payload. Multiple credential records may coexist. Saving the same
    Service DID and credentialId replaces that record atomically. Credential selection must never return a credential
    whose expiresAt is at or before the selection time; expired records may be removed lazily or by cleanup. Remote
    issuance followed by local persistence failure is a distinct partial-success failure and must not falsely report a
    usable local credential.

61. Decision: Grant is an action; Status presents Service lifecycle and local grant availability. Context: This controls
    CLI presentation only. It does not change the Service Grant response, validation, complete local credential storage,
    expiry enforcement, or later internal credential use. Contract: `inflow aep grant` obtains approval, requests and
    validates the complete Service credential, stores it, and returns a concise non-secret action result. It does not
    print credential secrets or a verbose inventory. Human Grant confirms issuance and storage. Agent Grant returns
    stable non-secret issuance metadata sufficient to identify the stored record.

62. Revised decision: Status combines authoritative Service lifecycle with explicitly local credential availability.
    Context: The AEP Service Status response is authoritative for enrollment state, Owner action, and pending
    requirements, but it does not report whether this CLI possesses an unexpired locally stored credential. Contract:
    Human Status presents the detailed Service lifecycle plus a local usable-grant summary without secrets. Agent Status
    uses an envelope with the complete validated Service Status response under `service` and locally derived credential
    summaries under `local.grants`. Each local summary contains credentialId, grantType, scopes, expiresAt when present,
    and usability, but never credential payload. Expired credentials are never reported as usable. The envelope keeps
    Service-authored state distinct from local Agent state and supersedes the earlier raw-Status-only JSON assumption.

63. Decision: Revoke returns a concise non-secret action result. Contract: After the Service accepts Revoke and local
    credential reconciliation succeeds, agent JSON confirms success and echoes the selected credentialId, grantType, or
    allGrantTypes selector without credential material. Human output gives a short confirmation. Revoke does not return
    the remaining credential inventory; Status presents remaining locally usable grants. The empty Service Revoke
    response remains a protocol transport detail rather than the CLI action result.

64. Decision: Bare Revoke invalidates all Service credentials; selectors are optional secondary behavior. Contract:
    `inflow aep revoke <service-reference>` sends the protocol `all_grant_types: "true"` selector and, after Service
    success, deletes every locally stored credential for the canonical Service DID. Advanced callers may instead supply
    exactly one `--credential-id` or `--grant-type`; the two flags are mutually exclusive. An explicit selector narrows
    both the Service Revoke request and successful local reconciliation. Revoke never automatically chooses a preferred
    credential.

65. Decision: Do not expose the AEP Node generic Revoke `parameters` escape hatch in the initial CLI. Context: AEP Node
    currently accepts `parameters?: Record<string, unknown>` and spreads it into Grant and Revoke request bodies, but
    the AEP specifications contain no registered Revoke extension or concrete source-backed example that defines such
    fields. The core Revoke contract defines only credential_id, grant_type, and all_grant_types. Contract: The initial
    CLI exposes only the core typed selectors. A future registered extension adds its own validated schema and flags;
    the CLI does not accept arbitrary unbounded request members.

66. Decision: Revoke action JSON follows existing CLI snake_case output conventions. Contract: CLI flags use kebab case
    (`--credential-id`, `--grant-type`). Agent JSON uses snake_case, matching existing `transaction_id`, `approval_id`,
    `instrument_id`, `output_saved_to`, and `credential_saved_to` result fields. Bare Revoke returns
    `{ "revoked": true, "all_grant_types": true }`; narrowed forms return `credential_id` or `grant_type`. This is an
    InFlow action result rather than the Service's empty protocol response.

67. Clarification: Revoke selection has distinct CLI, core, wire, and output representations. Contract: The CLI accepts
    `--grant-type oauth-bearer` and `--credential-id <value>`. Its command schema maps those display-shaped flags to
    core `grantType` and `credentialId`. AEP Node maps them to wire fields `grant_type` and `credential_id`. The
    registered grant-type value itself remains the advertised protocol string `oauth-bearer`; field name casing rules do
    not rewrite registered enum values to `oauth_bearer`. InFlow action JSON independently follows the repository's
    snake_case field convention.

68. Clarification: Generic `parameters` does not carry the core credential identifier selector. Context: AEP Node's
    typed Revoke selector already maps `credentialId` directly to wire `credential_id`. The generic parameters object is
    spread before the typed selector for additional fields that a future concrete credential specification might define;
    no current AEP credential specification supplies such an example. Contract: Keep credentialId in the typed selector
    path. Do not expose generic parameters in the initial CLI.

69. Decision: Freeze the Enroll, Status, Grant, and Revoke command schemas. Contract: Every command accepts one
    `service-reference` positional argument using the approved normalization. Inspect is logged-out; the other commands
    require InFlow authentication. Enroll supports optional `--interval` overriding Platform retry_after_seconds,
    `--max-attempts` default 0, and `--timeout` default and maximum 900; it always polls inline and rejects interval 0.
    Status takes no polling flags. Grant accepts optional `--grant-type` and repeatable `--scope`; omitted grant type
    selects the first advertised grant type, and scopes map to requested_scopes with stable exact de-duplication. Revoke
    defaults to all grant types and supports mutually exclusive `--credential-id` or `--grant-type` narrowing.

70. Decision: Freeze agent JSON contracts for all five commands. Contract: Inspect retains its approved versioned
    envelope. Enroll returns the complete validated Service response. Status returns `{ service, local: { grants } }`,
    preserving the complete Service Status response and listing local grant summaries sorted by grant_type then
    credential_id. Each summary contains credential_id, grant_type, scopes, optional expires_at, and usable.
    Credential-store access purges expired entries before Status builds the summary, so successfully returned Status
    results do not contain expired grants. Grant returns granted true plus credential_id, grant_type, scopes, and
    optional expires_at. Revoke returns revoked true plus exactly one of all_grant_types, credential_id, or grant_type.
    Grant and Revoke do not repeat Service DID or expose credential payloads.

71. Decision: Freeze human presentation for Enroll, Status, Grant, and Revoke. Contract: Enroll shows Service label and
    concise active, pending-verification, or rejected outcome; pending indicates Owner action when applicable and points
    to Status for details. Status shows Service identity, lifecycle, since, Owner action, pending
    verification/requirements, and a non-secret local grant table. Grant confirms issuance and storage with grant type
    and optional expiry. Revoke confirms the successful scope. Action commands never print credential secrets or
    automatically run Status.

72. Decision: Freeze stable CLI error contracts. Contract: Use AEP_SERVICE_URL_INVALID for invalid Service input; the
    existing session-guard error for missing InFlow authentication; AEP_IDENTITY_NOT_FOUND; approved typed
    Inspect/transport mappings; AEP_IDENTITY_PROVISION_FAILED; AEP_APPROVAL_DENIED; AEP_APPROVAL_TIMEOUT;
    AEP_SIGN_FAILED; AEP_REQUIREMENTS_UNMET; AEP_GRANT_TYPE_UNSUPPORTED; AEP_CREDENTIAL_INVALID; sanitized AEP Problem
    Details preserving the protocol code; AEP_LOCAL_PERSISTENCE_FAILED with partial_success true;
    AEP_LOCAL_RECONCILIATION_FAILED with partial_success true; and AEP_INTERNAL_ERROR. Invalid input and unsupported
    explicit grant type exit 2. Operational failures exit 1. Retryability follows the approved source category; valid
    lifecycle outcomes are successful protocol results.

73. Decision: Proactively remove expired credentials on every credential-store interaction. Context: Expiration must
    affect both selection and lifecycle maintenance. Leaving cleanup to a future command or separate manager permits
    indefinite stale secret retention in the temporary store. Contract: Every credential-store read or write begins by
    purging records whose expiresAt is at or before the supplied current time. Selection independently excludes expired
    records even if physical cleanup fails. A cleanup failure is a credential-store failure and is reported through the
    applicable command error or local-reconciliation path; it is never silently treated as successful cleanup. Built-in
    grant types require expires_at. Extension credentials may omit it only when their registered specification permits
    non-expiring credentials.

74. Decision: Freeze interruption and partial-success behavior. Contract: Controlled Enroll or Grant interruption
    best-effort cancels Approval, removes incomplete local state, and returns the existing interruption error; hard
    crashes rely on 900-second server cleanup. Remote Enroll or Grant success followed by storage failure returns
    AEP_LOCAL_PERSISTENCE_FAILED with partial_success true and non-secret identifiers. Remote Revoke success followed by
    local deletion failure returns AEP_LOCAL_RECONCILIATION_FAILED with partial_success true and does not automatically
    repeat the remote request.

## Active Focus Window

| Order | Status      | Focus                     | Next action                                                                                                                  |
| ----- | ----------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 40    | Done        | Enroll command contract   | Implement the approved Enroll inputs, identity provisioning, Service enrollment, outputs, and failure behavior.              |
| 42    | Done        | Server signing approval   | Implement approved operation-aware Sign, AEP Approval context, requester resolution, polling support, and disclosure return. |
| 44    | Done        | CLI approval continuation | Implement inline delegated-sign polling, decline, timeout, interruption, and approved-claim handling without resume.         |
| 46    | Not Started | Tier-aware AEP approval   | Refine approval presentation and decisions for required, preferred, and optional claims.                                     |
| 48    | Not Started | Seller DID population     | Design verified ownership and population lifecycle for Seller.serviceDid.                                                    |
| 60    | Done        | Status command            | Implement direct-sign Status with full agent JSON and detailed human lifecycle presentation.                                 |
| 70    | Done        | Grant command             | Implement LOGIN approval-backed Grant, complete expiry-aware credential storage, and concise non-secret action output.       |
| 80    | Done        | Revoke command            | Implement direct-sign Service revocation, optional narrowing selectors, and local reconciliation.                            |
| 82    | Done        | Exact CLI contracts       | Implement approved schemas, JSON fields, human projections, errors, expiry cleanup, and partial-success behavior.            |
| 110   | Done        | Enterprise secure store   | Delivered by Queue 2 Task 126 encrypted local vault daemon.                                                                  |

## No Buried Work Rule

Before every status update, pause point, handoff, or final control-return message, audit the response for future-tense
work, prevention work, risks, blockers, follow-ups, or "should do next" statements.

If the response mentions work that is not already represented in the queue, add it to the Active Focus Window and
Ordered Task List, add it to Missed Or Hidden Work Found for user vetting, add it to Decision Points, or move it to an
adjacent planning artifact before handing off.

## Decision Log

| Date       | Decision                                                                                                                                                          | Rationale                                                                                                                                                                                                                                                                                                                                                    | Source                                                                                                                                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-07-09 | Use the published AEP Node packages rather than copying protocol behavior into `inflow-cli`.                                                                      | The package owns AEP Agent network behavior and the user requested integration of `aep-node`.                                                                                                                                                                                                                                                                | User instruction; `../AEP/aep-node/INTEGRATION.md:11`                                                                                                                                                           |
| 2026-07-09 | Expose AEP as the top-level `inflow aep` command group.                                                                                                           | AEP is a distinct protocol and the user selected Option A.                                                                                                                                                                                                                                                                                                   | User decision in the active thread.                                                                                                                                                                             |
| 2026-07-09 | Include every identified Agent-side operation through staged delivery.                                                                                            | Inspect can ship without persistence; Enroll establishes the storage dependency; later commands follow in separate stages.                                                                                                                                                                                                                                   | User decision in the active thread.                                                                                                                                                                             |
| 2026-07-09 | Treat InFlow authentication and AEP authentication as separate systems.                                                                                           | InFlow authentication authorizes the Agent-side CLI to the InFlow Platform; Platform-signed AEP client assertions authenticate the Agent to Services.                                                                                                                                                                                                        | User decision; `inflow-server/src/main/java/ai/inflowpay/api/v1/interceptor/ApiAuthenticationInterceptor.java:154`; `inflow-server/src/main/java/ai/inflowpay/aep/platform/service/AepPlatformService.java:239` |
| 2026-07-09 | Use a dedicated storage interface with an initial single local JSON implementation.                                                                               | The interface permits staged delivery and a final migration task to an enterprise secure credential store.                                                                                                                                                                                                                                                   | User decision in the active thread.                                                                                                                                                                             |
| 2026-07-09 | Clear the logged-in user's local AEP records on InFlow account logout.                                                                                            | AEP state belongs to the authenticated InFlow user and may be regenerated; a later user must not access it.                                                                                                                                                                                                                                                  | User decision in the active thread.                                                                                                                                                                             |
| 2026-07-09 | Return Inspect as an envelope containing the complete validated document and resolved transport metadata.                                                         | This preserves extension fields while centralizing URL resolution and cache metadata; interactive mode renders a concise projection of the same result.                                                                                                                                                                                                      | User selected Inspect output Option C in the active thread.                                                                                                                                                     |
| 2026-07-09 | Normalize AEP Service references to an origin, infer HTTPS for host/path input, and permit plaintext HTTP only when explicitly supplied for exact loopback hosts. | AEP Inspect resolves the origin-level well-known path. The positional input accepts `did:web`, host, host/path, and absolute URL forms; path components do not affect the Service origin.                                                                                                                                                                    | User refined the Service-reference contract in the active thread; AEP core specification section “Discovery and Inspect.”                                                                                       |
| 2026-07-09 | Use the approved versioned Inspect JSON envelope without field changes.                                                                                           | The envelope separates the complete Service-authored document, core-resolved URLs, and observed HTTP response metadata while preserving unknown extension fields.                                                                                                                                                                                            | User selected Inspect envelope Option A in the active thread.                                                                                                                                                   |
| 2026-07-09 | Keep Stage 1 Inspect stateless and fetch on every invocation.                                                                                                     | Inspect returns observed cache metadata but creates no local cache, adds no refresh flag, and does not pull storage ownership or migration into Stage 1. Shared persistent HTTP-aware caching is staged after the storage interface exists.                                                                                                                  | User selected Inspect cache Option A in the active thread.                                                                                                                                                      |
| 2026-07-09 | Use six stable Inspect error codes with explicit retry and exit semantics.                                                                                        | Caller input, network, HTTP, malformed JSON, invalid AEP document, and unexpected internal failures require distinct automation behavior. Invalid input exits `2`; operational failures exit `1`; native errors and response bodies are not exposed.                                                                                                         | User selected Inspect error Option A in the active thread.                                                                                                                                                      |
| 2026-07-09 | Follow at most five same-origin Inspect redirects and reject every cross-origin redirect or scheme downgrade.                                                     | Automatic redirects must not silently transfer Inspect origin trust. The output reports the final accepted Inspect URL, and rejected redirects use a dedicated stable error code.                                                                                                                                                                            | User selected Inspect redirect Option B in the active thread.                                                                                                                                                   |
| 2026-07-09 | Use a configurable total Inspect deadline with a 30-second default and 300-second maximum.                                                                        | Inspect must not hang indefinitely. The deadline covers redirects and body reading; timeout is retryable, unlimited mode is not supported, and later AEP commands reuse the same core deadline policy.                                                                                                                                                       | User selected Inspect timeout Option B in the active thread.                                                                                                                                                    |
| 2026-07-09 | Push reusable protocol behavior into `aep-node` and normative requirements into `aep-specs` where meaningful.                                                     | `inflow-cli` owns product policy, command contracts, rendering, and orchestration; it must not duplicate protocol transport or validation behavior owned by the software development kit.                                                                                                                                                                    | User instruction in the active thread.                                                                                                                                                                          |
| 2026-07-09 | Require the `application/aep+json` media-type essence on successful Inspect responses.                                                                            | Content negotiation is part of the protocol contract. Valid parameters are accepted; missing, malformed, or different media types are rejected before body parsing with a typed software development kit failure and stable CLI error.                                                                                                                       | User selected Inspect media-type Option A in the active thread.                                                                                                                                                 |
| 2026-07-09 | Bound Inspect responses to a secure one-mebibyte decoded-body default in `aep-node`.                                                                              | The limit is enforced while streaming and remains configurable for embedded software development kit consumers; `inflow-cli` uses the secure default without exposing an override.                                                                                                                                                                           | User selected Inspect response-size Option C in the active thread.                                                                                                                                              |
| 2026-07-09 | Render interactive Inspect as a polished human capability summary rather than a transport report.                                                                 | Human output includes the copyable Service URL but omits Bindings, Inspect URL, HTTP metadata, and resolved command URLs. Agent-mode JSON retains the complete document and technical metadata.                                                                                                                                                              | User approved a modified interactive Option A and clarified Service URL display in the active thread.                                                                                                           |
| 2026-07-09 | Allow AEP Inspect without an InFlow login.                                                                                                                        | Existing `inflow mpp inspect` is an unauthenticated read-only probe, and AEP Inspect is also protocol-level unauthenticated discovery. AEP Inspect receives no auth storage or InFlow client dependency and never invokes the session guard.                                                                                                                 | User instructed AEP Inspect to follow verified MPP Inspect behavior.                                                                                                                                            |
| 2026-07-09 | Accept full resource locators as AEP Service input and discard path, query, and fragment components.                                                              | An agent may reuse any protected or ordinary resource URL, including MPP and x402 URLs, for AEP discovery. Normalization extracts only the Service origin before network access, persistence, output, or error reporting.                                                                                                                                    | User selected Service-reference Option A and supplied the protocol-neutral resource-locator use case in the active thread.                                                                                      |
| 2026-07-09 | Do not encode the current absence of an Inspect signature as a durable design or new normative premise.                                                           | Signed Inspect is a planned enhancement. Stage 1 reports current validation accurately while preserving an extension path for signature material, verification state, and trust policy.                                                                                                                                                                      | User instruction in the active thread.                                                                                                                                                                          |
| 2026-07-09 | Reject Service URLs containing embedded username or password information.                                                                                         | User information can visually disguise the actual hostname and is unrelated to unauthenticated Inspect. Rejection prevents origin confusion, and errors never echo the credential-bearing input.                                                                                                                                                             | User selected embedded-credential Option B in the active thread.                                                                                                                                                |
| 2026-07-09 | Establish the permanent `inflow.aep` core handle in Stage 1 with `inspect()`.                                                                                     | This matches the repository's one-handle-per-command-group architecture and allows later stages to extend one stable integration shape without temporary functions or volatile placeholder stores.                                                                                                                                                           | User selected core architecture Option A in the active thread.                                                                                                                                                  |
| 2026-07-09 | Follow the existing MPP and x402 dependency pattern for `@aep-foundation/agent`.                                                                                  | Private core declares the Agent package as a peer and development dependency; the published CLI declares it as a runtime dependency and consumes a released npm version.                                                                                                                                                                                     | User instruction in the active thread.                                                                                                                                                                          |
| 2026-07-09 | Make Stage 1 `aep-node` changes additive.                                                                                                                         | Add a reusable Service-reference resolver and narrow Inspect signal, body-limit, final-URL, redirect, media-type, and typed-failure behavior without renaming the existing `serviceUrl` lifecycle interfaces.                                                                                                                                                | User selected software development kit interface Option A in the active thread.                                                                                                                                 |
| 2026-07-09 | Add focused normative Inspect transport requirements to `aep-specs`.                                                                                              | Specify media-type enforcement, same-origin redirect trust, and implementation-defined response-size and completion-time limits without describing signature absence as permanent or constraining the planned signed-Inspect enhancement.                                                                                                                    | User selected specification Option A in the active thread.                                                                                                                                                      |
| 2026-07-09 | Deliver Stage 1 in specification, software development kit, then CLI authority order, with local linked validation before publication.                            | `aep-specs` defines the contract, `aep-node` implements it, and `inflow-cli` consumes it. A managed local pnpm link validates the integration before the software development kit pull request and npm release; committed CLI dependencies still use the released registry version.                                                                          | User selected delivery Option A and required use of the local link workflow in the active thread.                                                                                                               |
| 2026-07-09 | Expand the existing local link and unlink scripts to manage AEP packages; do not create fragmented AEP-specific scripts.                                          | One workflow owns the marked pnpm override block and validates both local software development kit repositories. The AEP link set includes the Agent package's local Core and Platform dependency closure.                                                                                                                                                   | User instruction in the active thread.                                                                                                                                                                          |
| 2026-07-09 | Expose one discriminated `AepInspectError` and a separate `AepServiceReferenceError` from `aep-node`.                                                             | Every known Inspect transport or validation failure maps without prose parsing; Service-reference failures remain separate; exhaustive core switches surface newly added software development kit reasons at compile time.                                                                                                                                   | User selected software development kit error Option A in the active thread.                                                                                                                                     |
| 2026-07-10 | Use one composed AEP storage boundary with typed sub-stores.                                                                                                      | Identity and credential ports share one lifecycle boundary while remaining independently replaceable. Inspect is stateless, and incomplete operations are not persisted. The initial JSON implementation may use one physical repository; an enterprise implementation can move secret credentials without changing flows.                                   | User selected the composed boundary and later rejected resumable operation storage in the active thread.                                                                                                        |
| 2026-07-10 | Bind the active local AEP store to canonical InFlow Platform origin plus authenticated `userId`.                                                                  | Ownership is verified before any record access. Mismatch fails closed and may replace disposable prior state with a new empty store, preventing production, sandbox, custom deployment, or cross-user leakage.                                                                                                                                               | User selected storage-ownership Option B in the active thread.                                                                                                                                                  |
| 2026-07-10 | Logout attempts AEP state deletion, always clears InFlow authentication, and reports partial cleanup failure.                                                     | A broken AEP store cannot prevent logout, but residual local Service credentials are not silently ignored. Owner validation continues to prevent later-user access.                                                                                                                                                                                          | User selected logout Option B in the active thread.                                                                                                                                                             |
| 2026-07-10 | Preserve AEP state for exact-owner re-authentication and delete it when authentication changes owner.                                                             | Owner is canonical Platform origin plus `userId`. New authentication remains durable if cleanup fails, but AEP stays unavailable and the command reports a nonzero partial-transition failure until residual state is removed.                                                                                                                               | User selected authentication-transition Option A in the active thread.                                                                                                                                          |
| 2026-07-10 | Store the initial AEP state as a versioned subtree in the existing auth JSON file.                                                                                | One mode-`0o600` file owns authentication and initial AEP state. The composed AEP interface hides the physical layout so later enterprise credential storage can replace it without changing flows.                                                                                                                                                          | User selected file-placement Option B in the active thread.                                                                                                                                                     |
| 2026-07-10 | Version only the persisted `aep` subtree with an integer schema version.                                                                                          | AEP migrations remain independent from auth semantics. Missing or null AEP state means uninitialized; known older versions migrate sequentially; unsupported newer versions fail closed without rewrite.                                                                                                                                                     | User selected schema-version Option A in the active thread.                                                                                                                                                     |
| 2026-07-10 | Store Agent identities in an object map keyed by canonical Service DID.                                                                                           | The stored value is the runtime-validated `AgentServiceIdentity` persistence record; contained Service DID must match the key, writes replace atomically, metadata preserves unknown fields, and Platform-hosted records contain no private signing key.                                                                                                     | User selected identity-schema Option A in the active thread.                                                                                                                                                    |
| 2026-07-10 | Accept last-writer-wins concurrency for the temporary shared JSON config file.                                                                                    | The initial file is a legacy bridge that will be replaced. It provides atomic individual file writes through `conf` but makes no cross-process transaction guarantee. Enterprise concurrency is deferred until the future secure store is selected.                                                                                                          | User instruction in the active thread.                                                                                                                                                                          |
| 2026-07-10 | Source Enroll claims through approval-mediated Platform delegated signing.                                                                                        | The CLI passes the Service-requested claim context into the AEP delegated signer. Initial `sign(ENROLL)` creates the InFlow Approval, the CLI waits through the existing approval lifecycle, and final Sign returns the assertion plus only the approved disclosure needed for Service Enroll. Claims are neither entered into the CLI nor sourced silently. | User corrected the approval trigger point in the active thread.                                                                                                                                                 |
| 2026-07-10 | Reuse a refactored `REGISTER` approval for delegated `sign(ENROLL)`.                                                                                              | Registration is the normalized user action. Register creation, policy, notifications, and presentation will accept a Service DID with an optional mapped InFlow requester identifier; the Service DID remains authoritative and unregistered Services remain supported.                                                                                      | User selected Option A in the active thread.                                                                                                                                                                    |
| 2026-07-10 | Add optional generic `platform_context` to Platform delegated sign requests.                                                                                      | Platforms may use local authorization, custody, tenant, or compliance inputs without changing client-assertion claims. The software development kit transports the object unchanged; InFlow defines `approval_id` within its Platform profile.                                                                                                               | User selected Option A in the active thread.                                                                                                                                                                    |
| 2026-07-10 | Persist narrow typed AEP request-binding data in AepSignContext.                                                                                                  | The record stores approval, identity, Service, operation, structured claim names, fingerprint, lifecycle timestamps, and signing completion state. Approval envelope data remains in Approval; raw request JSON is not retained.                                                                                                                             | User refined the context name and typed claim structure in the active thread.                                                                                                                                   |
| 2026-07-10 | Create InFlow authorization inside delegated Sign.                                                                                                                | The initial request carries InFlow authorization input through platform_context; InFlow creates AepSignContext and final Approval directly. A pending response returns approval_id for polling and final Sign.                                                                                                                                               | User consolidated the API flow in the active thread.                                                                                                                                                            |
| 2026-07-10 | Define a generic asynchronous Platform Sign response.                                                                                                             | HTTP 202 returns pending status, opaque Platform continuation context, and retry guidance; HTTP 200 remains the completed assertion response. InFlow returns approval_id inside platform_context for CLI polling and completion.                                                                                                                             | User selected asynchronous Sign Option A in the active thread.                                                                                                                                                  |
| 2026-07-10 | Standardize Platform HTTP idempotency in Idempotency-Key headers.                                                                                                 | Provision, delegated Sign, and hosted Verification require the header. Verification is included because it consumes replay state. Read-only calls remain keyless, and lifecycle PATCH remains naturally idempotent while it only sets status. The unposted Platform draft can be corrected before publication.                                               | User approved the holistic Platform idempotency direction in the active thread.                                                                                                                                 |
| 2026-07-10 | Require at least one hour of Platform idempotency-result retention.                                                                                               | This matches AEP core. Implementations may retain longer, and durable domain uniqueness continues protecting state after cached responses expire.                                                                                                                                                                                                            | User selected retention Option A in the active thread.                                                                                                                                                          |
| 2026-07-10 | Use one shared generic idempotency cache across Platform operations.                                                                                              | Records are keyed by authenticated principal plus Idempotency-Key. The stored operation and canonical request fingerprint detect reuse across endpoints or changed input and return idempotency_conflict.                                                                                                                                                    | User selected scope Option C for a shared generic cache in the active thread.                                                                                                                                   |
| 2026-07-10 | Use authenticated userId as InFlow's Platform idempotency principal.                                                                                              | Credential rotation or authentication mechanism changes do not change the user's idempotency namespace.                                                                                                                                                                                                                                                      | User clarified the principal in the active thread.                                                                                                                                                              |
| 2026-07-10 | Carry pending Sign retry guidance only in JSON.                                                                                                                   | HTTP 202 body contains pending status, platform_context, and retry_after_seconds. The contract does not duplicate timing in Retry-After.                                                                                                                                                                                                                     | User selected pending-response Option B in the active thread.                                                                                                                                                   |
| 2026-07-10 | Encode retry_after_seconds as a required positive decimal string.                                                                                                 | This follows AEP-owned numeric wire conventions. The software development kit exposes a validated numeric value and callers do not invent a missing default.                                                                                                                                                                                                 | User confirmed the source-backed convention in the active thread.                                                                                                                                               |
| 2026-07-10 | Bound retry_after_seconds to 1 through 300.                                                                                                                       | The bound prevents tight loops and pathological timers while remaining independent of approval lifetime and caller timeout. Out-of-range responses are invalid and are not clamped.                                                                                                                                                                          | User selected range Option A in the active thread.                                                                                                                                                              |
| 2026-07-10 | Require status on both Platform Sign response variants.                                                                                                           | HTTP 200 uses completed and HTTP 202 uses pending, producing a clean discriminated union before the Platform draft is published.                                                                                                                                                                                                                             | User selected response-discriminant Option A in the active thread.                                                                                                                                              |
| 2026-07-10 | Make platform_context optional on Sign requests and responses.                                                                                                    | The field is omitted when empty and included only when a Platform has local data to transport. InFlow pending includes approval_id; completed ENROLL includes approved_claims.                                                                                                                                                                               | User clarified the platform_context presence contract and corrected completed disclosure flow in the active thread.                                                                                             |
| 2026-07-10 | Use mutually exclusive InFlow initiation and completion context shapes.                                                                                           | Initiation requires structured claims and forbids approval_id. Completion requires approval_id and forbids claims, loading the immutable binding from AepSignContext.                                                                                                                                                                                        | User selected context-shape Option A and refined the structured request in the active thread.                                                                                                                   |
| 2026-07-10 | Preserve Inspect claim tiers through the InFlow Sign API.                                                                                                         | inflow-cli sends required, preferred, and optional arrays under platform_context.claims. inflow-server persists the structure and flattens it only when creating today's Approval UserDetails.                                                                                                                                                               | User corrected the API design boundary in the active thread.                                                                                                                                                    |
| 2026-07-10 | Require Inspect claim tiers to be pairwise disjoint.                                                                                                              | Overlap is an invalid Inspect document enforced by aep-node; neither the CLI nor inflow-server repairs tier ambiguity.                                                                                                                                                                                                                                       | User selected overlap Option A in the active thread.                                                                                                                                                            |
| 2026-07-10 | Put AEP claim-name mappings in UserDetail.java.                                                                                                                   | UserDetail resolves supported claim aliases to approval categories and exposes the reverse category vocabulary; no separate mapping service or Foundation catalog is required for this integration.                                                                                                                                                          | User selected mapping Option C and specified the owning file in the active thread.                                                                                                                              |
| 2026-07-10 | Emit only exact requested claim keys after category approval.                                                                                                     | A claim such as person.first_name can resolve to NAME, but approval does not authorize emitting unrequested NAME aliases such as person.last_name.                                                                                                                                                                                                           | User selected reverse-mapping Option A and clarified final Service disclosure in the active thread.                                                                                                             |
| 2026-07-10 | Keep AEP claim mapping and approved-claim construction in inflow-server.                                                                                          | The server resolves structured claim names through UserDetail, flattens Approval UserDetails, preserves exact request names, and emits exact approved_claims; the CLI has no duplicate mapping table.                                                                                                                                                        | User clarified server-side mapping ownership in the active thread.                                                                                                                                              |
| 2026-07-10 | Use initial delegated Sign as the InFlow claim-mapping endpoint.                                                                                                  | Sign receives structured platform_context.claims at the authorization boundary and creates AepSignContext plus REGISTER Approval.                                                                                                                                                                                                                            | User selected mapping-endpoint Option A in the active thread.                                                                                                                                                   |
| 2026-07-10 | Fail only unsupported required claims during InFlow mapping.                                                                                                      | Unsupported required names prevent session and Approval creation. Recognized non-required claims proceed; unsupported preferred/optional names are silently dropped before typed persistence.                                                                                                                                                                | User selected Option A and later revised non-required diagnostics in the active thread.                                                                                                                         |
| 2026-07-10 | Return requirements_unmet for unsupported required claims.                                                                                                        | HTTP 422 carries exact unsupported required names without claim values, reusing the existing core AEP error semantics.                                                                                                                                                                                                                                       | User selected error Option A in the active thread.                                                                                                                                                              |
| 2026-07-10 | Return exact approved claims from completed delegated Sign.                                                                                                       | Approval polling observes decision state only. Sign completion validates approval, issues the assertion, and returns platform_context.approved_claims for direct Service Enroll.                                                                                                                                                                             | User corrected the flow in the active thread.                                                                                                                                                                   |
| 2026-07-10 | Link AepSignContext to Approval by approvalId and mark ApprovalFlags.BIT_AEP.                                                                                     | This avoids another nullable Approval column. Completion authorizes Approval first, checks the flag, then loads the unique context; missing context fails closed.                                                                                                                                                                                            | User proposed and approved the relationship design in the active thread.                                                                                                                                        |
| 2026-07-10 | Represent supported AEP claims with AepClaim and AepClaims.                                                                                                       | AepSignContext stores typed required, preferred, and optional collections; UserDetail maps to AepClaim rather than raw strings; every AEP Sign Approval sets BIT_AEP.                                                                                                                                                                                        | User restructured the claim persistence model in the active thread.                                                                                                                                             |
| 2026-07-10 | Poll existing Approval GET for status only.                                                                                                                       | The endpoint receives no AEP-specific response behavior or fields. APPROVED tells the CLI to call final Sign. BIT_AEP is internal persistence/integrity state, not part of polling.                                                                                                                                                                          | User corrected the polling boundary in the active thread.                                                                                                                                                       |
| 2026-07-10 | Use string claim lists at the API boundary and typed AepClaims in persistence.                                                                                    | String lists allow detection of unsupported required names. Recognized names map to AepClaim; unsupported preferred/optional names are silently dropped and never stored.                                                                                                                                                                                    | User revised the claim-boundary design in the active thread.                                                                                                                                                    |
| 2026-07-10 | Support the complete initial AepClaim mapping.                                                                                                                    | Nine exact claim names map into the eight existing UserDetail approval categories; NAME maps first and last name separately, and final Sign emits only requested keys.                                                                                                                                                                                       | User selected mapping Option A in the active thread.                                                                                                                                                            |
| 2026-07-10 | Rename the durable signing record to AepSignContext.                                                                                                              | It stores binding context across initial Sign, Approval, and final Sign while Approval remains the lifecycle authority.                                                                                                                                                                                                                                      | User selected naming Option A in the active thread.                                                                                                                                                             |
| 2026-07-10 | Bulk-delete AepSignContext before Approval batch deletion.                                                                                                        | The same Approval status/age predicate drives a set-based child delete in one writer transaction, avoiding row loading and duplicated child status.                                                                                                                                                                                                          | User selected cleanup Option A in the active thread.                                                                                                                                                            |
| 2026-07-10 | Map final Sign outcomes from Approval state.                                                                                                                      | Pending remains 202; approved completes; declined/cancelled returns authorization_denied; missing, wrong-user, or non-AEP remains not_recognized; inconsistent flagged state fails closed.                                                                                                                                                                   | User selected state-mapping Option A in the active thread.                                                                                                                                                      |
| 2026-07-10 | Resolve AEP requesterId through unique Seller.serviceDid.                                                                                                         | Exact validated DID lookup supplies Seller.sellerId when present; no match leaves requesterId null. Hostname inference is forbidden, and population is outside the current delivery.                                                                                                                                                                         | User proposed the Seller mapping design in the active thread.                                                                                                                                                   |
| 2026-07-10 | Resolve only APPROVED Sellers by serviceDid.                                                                                                                      | ONBOARDING, REVIEW, and unmatched Sellers do not supply requesterId; the authoritative Service DID remains available and AEP continues.                                                                                                                                                                                                                      | User selected Seller-status Option A in the active thread.                                                                                                                                                      |
| 2026-07-10 | Present mapped Seller.name or the validated Service DID host.                                                                                                     | The full Service DID remains authoritative secondary detail; Register notification and dashboard rendering never dereference Seller unconditionally.                                                                                                                                                                                                         | User selected requester-label Option A in the active thread.                                                                                                                                                    |
| 2026-07-10 | Never implicitly resume a prior operation from `aep enroll`.                                                                                                      | Every Enroll invocation is a new logical operation. Pending work continues only through an explicit action, never by matching Service DID or claim fingerprint.                                                                                                                                                                                              | User corrected the CLI continuation boundary in the active thread.                                                                                                                                              |
| 2026-07-10 | Provide no AEP Enroll resume surface.                                                                                                                             | Incomplete attempts are abandoned and local state is removed. Controlled interruption best-effort cancels the Approval; server cleanup handles cancelled or crash-abandoned records. A later Enroll always starts new.                                                                                                                                       | User explicitly rejected resume and required incomplete Enroll removal in the active thread.                                                                                                                    |
| 2026-07-10 | Return Service enrollment pending as a valid command outcome.                                                                                                     | InFlow approval is complete; Service pending is durable AEP lifecycle state. Preserve identity and let the later Status command observe progress.                                                                                                                                                                                                            | User selected Service-pending Option A in the active thread.                                                                                                                                                    |
| 2026-07-10 | Separate Enroll transport/JSON fidelity from human presentation.                                                                                                  | The Service Enroll response mirrors or closely relates to Status, and agent JSON preserves the complete validated response. Human Enroll output remains concise because Status owns the verbose human lifecycle presentation. Only the Service-DID-to-Agent-identity mapping is persisted locally.                                                           | User corrected the three distinct contracts in the active thread.                                                                                                                                               |
| 2026-07-10 | Require approval for ENROLL and GRANT Sign operations, but directly sign STATUS and REVOKE.                                                                       | Enrollment and credential grants require user authorization; lifecycle observation and revocation do not create an Approval. The generic AEP Sign contract remains Platform-neutral.                                                                                                                                                                         | User supplied the operation-specific Sign policy in the active thread.                                                                                                                                          |
| 2026-07-10 | Confirm repeat-Enroll identity, raw JSON, rejected outcome, and partial-success behavior.                                                                         | Identity persistence is separate from operation resumption and Service lifecycle state; agent JSON preserves the protocol response without an InFlow envelope.                                                                                                                                                                                               | User approved assumptions 11, 14, 21, 24, and 25 in the active thread.                                                                                                                                          |

## Source Authority Order

When sources disagree, resolve them in this order unless the user says otherwise:

1. Current repository source.
2. User decisions in the active thread.
3. AEP Node source and AEP specifications.
4. Generated artifacts.
5. Agent inference.

## Provenance Boundary

| Surface or capability                | Provenance                                                                                | Queue treatment                                                       |
| ------------------------------------ | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `inflow aep inspect`                 | AEP Service operation plus explicit user decisions                                        | Approved public command.                                              |
| `inflow aep enroll`                  | AEP Service operation plus explicit user decisions                                        | Approved public command.                                              |
| `inflow aep status`                  | AEP Service operation plus explicit user decisions                                        | Approved public command.                                              |
| `inflow aep grant`                   | AEP Service operation plus explicit user decisions                                        | Approved public command.                                              |
| `inflow aep revoke`                  | AEP Service operation plus explicit user decisions                                        | Approved public command.                                              |
| Platform identity provisioning       | AEP Platform specification and existing InFlow Server endpoint                            | Supporting internal flow, not a Service CLI command.                  |
| Platform delegated Sign              | AEP Platform specification, existing server endpoint, and approved asynchronous extension | Supporting internal flow, not a Service CLI command.                  |
| Agent identity storage               | Required by the Agent software development kit and approved persistence model             | Internal storage capability, not an Identity command.                 |
| Credential authentication headers    | Existing AEP Node session method                                                          | Internal consumption capability, not a `headers` command.             |
| Protected-resource request execution | Existing MPP/x402 product behavior, not an AEP Service operation                          | Outside this queue; no `aep request` command is designed or approved. |
| Resume                               | Explicitly rejected by the user                                                           | No command, flag, journal, or cross-invocation continuation.          |

No public CLI surface may be added to this queue solely because the software development kit exposes a method with a
similar capability. A new public command requires an AEP Service operation or an explicit user instruction.

## Assumptions

| Assumption                                                                     | Why acceptable                                                                                                            | Revisit trigger                                                                     |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| The first integration is Agent-side, not Service-side or Platform-server-side. | The user asked to bring `aep-node` into a buyer-oriented CLI and the Agent package supplies the matching client workflow. | The user requests Service hosting, Platform administration, or conformance tooling. |
| `_QUEUE1.md` is the task filename for this repository.                         | No queue file exists here, and the supplied source uses `_QUEUE<N>.md`.                                                   | The user specifies another filename or queue number.                                |

## Engineering Posture

All design and implementation work in this queue must be:

- DRY: protocol behavior, schemas, storage logic, rendering projections, and error mapping have one authoritative
  implementation at the correct package boundary. Reuse must preserve clear ownership rather than create generic
  abstractions without demonstrated consumers.
- Performant: avoid repeated discovery, identity provisioning, signing setup, configuration reads, and unnecessary
  network calls. Performance decisions must preserve correctness, cache invalidation, credential isolation, and
  observable failure behavior.
- Long term: public commands, output contracts, storage schemas, and core interfaces must support compatible evolution,
  migration, and additional AEP identity modes without requiring a rewrite of the first integration.
- Enterprise aligned: treat tenancy, principal isolation, authorization audience, credential custody, auditability,
  deterministic automation, lifecycle management, policy boundaries, migration, and operational diagnostics as design
  requirements rather than later additions.

These qualities do not justify speculative frameworks. Every abstraction and persistence boundary must be grounded in
the current repositories, the AEP contract, or an approved near-term extension point.

## Current Source-Backed State

Source evidence:

| Claim                                                                                                                                                                                                    | Source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The published Agent package is `@aep-foundation/agent` version `0.1.1` and supports Node.js 22 or newer.                                                                                                 | `/Users/nxkavian/Drive/Source/AEP/aep-node/packages/agent/package.json:2`, `/Users/nxkavian/Drive/Source/AEP/aep-node/packages/agent/package.json:3`, `/Users/nxkavian/Drive/Source/AEP/aep-node/packages/agent/package.json:37`                                                                                                                                                                                                                                                                                                |
| The Agent package owns Inspect and AEP command networking; the application owns durable storage, authorization, and identity custody.                                                                    | `/Users/nxkavian/Drive/Source/AEP/aep-node/INTEGRATION.md:8`, `/Users/nxkavian/Drive/Source/AEP/aep-node/INTEGRATION.md:11`, `/Users/nxkavian/Drive/Source/AEP/aep-node/INTEGRATION.md:42`                                                                                                                                                                                                                                                                                                                                      |
| One `AepAgent` creates Service sessions exposing authentication headers, Enroll, Grant, Identity, Inspect, Revoke, and Status.                                                                           | `/Users/nxkavian/Drive/Source/AEP/aep-node/packages/agent/src/index.ts:324`, `/Users/nxkavian/Drive/Source/AEP/aep-node/packages/agent/src/index.ts:378`                                                                                                                                                                                                                                                                                                                                                                        |
| Agent identity, credential, idempotency-key, and Inspect-cache ports are injectable; defaults are in-memory.                                                                                             | `/Users/nxkavian/Drive/Source/AEP/aep-node/packages/agent/src/index.ts:61`, `/Users/nxkavian/Drive/Source/AEP/aep-node/packages/agent/src/index.ts:382`                                                                                                                                                                                                                                                                                                                                                                         |
| Grant persists the returned credential through the configured credential store; Revoke deletes matching locally stored credentials after a successful command.                                           | `/Users/nxkavian/Drive/Source/AEP/aep-node/packages/agent/src/index.ts:558`, `/Users/nxkavian/Drive/Source/AEP/aep-node/packages/agent/src/index.ts:579`, `/Users/nxkavian/Drive/Source/AEP/aep-node/packages/agent/src/index.ts:591`                                                                                                                                                                                                                                                                                           |
| The platform-hosted identity provider requires a Platform URL and optionally accepts an Authorization value.                                                                                             | `/Users/nxkavian/Drive/Source/AEP/aep-node/packages/agent/src/index.ts:292`, `/Users/nxkavian/Drive/Source/AEP/aep-node/packages/agent/src/index.ts:777`                                                                                                                                                                                                                                                                                                                                                                        |
| `inflow-cli` registers top-level command groups from one `Inflow` instance and distinguishes agent mode using explicit format, Model Context Protocol mode, or a non-interactive standard output stream. | `packages/cli/src/cli.tsx:142`, `packages/cli/src/cli.tsx:169`, `packages/cli/src/cli.tsx:215`                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| CLI command flags and Model Context Protocol input share colocated schemas.                                                                                                                              | `AGENTS.md` under “Schemas drive flags AND MCP tool input”; `packages/cli/src/commands/mpp/schema.ts:1`                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Existing persisted InFlow auth uses a mode-`0o600` `conf` file and stores OAuth tokens, an API key, pending device auth, and connection settings.                                                        | `packages/core/src/utils/storage.ts:26`, `packages/core/src/utils/storage.ts:59`, `packages/core/src/utils/storage.ts:85`                                                                                                                                                                                                                                                                                                                                                                                                       |
| Existing logout clears every artifact in that auth store.                                                                                                                                                | `packages/core/src/utils/storage.ts:47`, `packages/core/src/utils/storage.ts:165`                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| InFlow Server is the AEP Platform and publishes unauthenticated discovery at `/.well-known/aep-platform`.                                                                                                | `/Users/nxkavian/Drive/Source/InFlow/inflow-server/src/main/java/ai/inflowpay/www/v1/controller/user/WellKnownController.java:70`                                                                                                                                                                                                                                                                                                                                                                                               |
| Platform operations live under `/v1/aep`; list, provision, sign, identity status, lifecycle update, and hosted verification require an authenticated InFlow user.                                        | `/Users/nxkavian/Drive/Source/InFlow/inflow-server/src/main/java/ai/inflowpay/api/v1/controller/AepPlatformController.java:45`, `/Users/nxkavian/Drive/Source/InFlow/inflow-server/src/main/java/ai/inflowpay/api/v1/controller/AepPlatformController.java:58`                                                                                                                                                                                                                                                                  |
| The Platform authentication interceptor derives the InFlow user from either a Platform API key or an OAuth token.                                                                                        | `/Users/nxkavian/Drive/Source/InFlow/inflow-server/src/main/java/ai/inflowpay/api/v1/interceptor/ApiAuthenticationInterceptor.java:154`                                                                                                                                                                                                                                                                                                                                                                                         |
| Platform identity list, status, signing, and lifecycle operations are scoped to the authenticated InFlow user identifier.                                                                                | `/Users/nxkavian/Drive/Source/InFlow/inflow-server/src/main/java/ai/inflowpay/api/v1/controller/AepPlatformController.java:69`, `/Users/nxkavian/Drive/Source/InFlow/inflow-server/src/main/java/ai/inflowpay/api/v1/controller/AepPlatformController.java:85`, `/Users/nxkavian/Drive/Source/InFlow/inflow-server/src/main/java/ai/inflowpay/api/v1/controller/AepPlatformController.java:92`, `/Users/nxkavian/Drive/Source/InFlow/inflow-server/src/main/java/ai/inflowpay/api/v1/controller/AepPlatformController.java:101` |
| Provisioning stores each identity against the authenticated InFlow user and the requested Service DID.                                                                                                   | `/Users/nxkavian/Drive/Source/InFlow/inflow-server/src/main/java/ai/inflowpay/aep/platform/service/AepPlatformService.java:99`, `/Users/nxkavian/Drive/Source/InFlow/inflow-server/src/main/java/ai/inflowpay/aep/platform/service/AepPlatformService.java:170`                                                                                                                                                                                                                                                                 |
| Delegated signing creates an AEP client assertion whose issuer and subject are the Agent DID and whose audience is the Service DID.                                                                      | `/Users/nxkavian/Drive/Source/InFlow/inflow-server/src/main/java/ai/inflowpay/aep/platform/service/AepPlatformService.java:239`                                                                                                                                                                                                                                                                                                                                                                                                 |

## Scope Boundary

Queue 1 includes:

- Agent-side AEP CLI and core-client design.
- Hosted identity-provider configuration and authorization design.
- Durable local storage and principal-scoping design.
- Interactive and agent-mode command behavior and output contracts.
- Dependency, documentation, testing, Changeset, and release work breakdown.
- Required `inflow-server` AEP claim-disclosure and approval integration design.

Queue 1 does not own:

- AEP Service implementation or server adapters.
- AEP Platform server implementation.
- Sovereign local key custody unless the user explicitly selects it for the first release.
- Implementation before the design decisions are approved.
- Implementing multiple command stages in one undifferentiated batch.

## Priority Definitions

- P0: Blocks the queue goal.
- P1: Required for a correct, durable result.
- P2: Valuable follow-up that must be completed or explicitly re-homed before this queue closes.
- P3: Long-tail work that can be deferred with little consequence.

## Lift Scale

- 1: Trivial.
- 2-3: Small and clear.
- 4-5: Moderate and bounded.
- 6-8: Large or ambiguous; split before starting.
- 9+: Too large for one task; split before starting.

## Research Notes

| Topic                                      | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                  | Source                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent package boundary                     | Applications supply storage and identity custody, but the Agent package owns AEP HTTP transport and validation.                                                                                                                                                                                                                                                                                                                          | `/Users/nxkavian/Drive/Source/AEP/aep-node/packages/agent/README.md:16`                                                                                                                                                                                                                                                                                                                     |
| Principal isolation                        | Production integrations create one Agent per principal or scope every store lookup by principal.                                                                                                                                                                                                                                                                                                                                         | `/Users/nxkavian/Drive/Source/AEP/aep-node/INTEGRATION.md:27`                                                                                                                                                                                                                                                                                                                               |
| Credential preference                      | Session authentication headers prefer a usable issued credential and fall back to a client assertion unless disabled.                                                                                                                                                                                                                                                                                                                    | `/Users/nxkavian/Drive/Source/AEP/aep-node/packages/agent/src/index.ts:520`                                                                                                                                                                                                                                                                                                                 |
| CLI architecture                           | Existing protocol command groups are thin CLI render shells over core flows and handles.                                                                                                                                                                                                                                                                                                                                                 | `AGENTS.md` under “What this repo is”                                                                                                                                                                                                                                                                                                                                                       |
| Engineering posture                        | Work must be DRY, performant, long term, and enterprise aligned.                                                                                                                                                                                                                                                                                                                                                                         | User instruction in the active thread, 2026-07-09.                                                                                                                                                                                                                                                                                                                                          |
| Inspect integrity                          | The current Inspect schema has no signature field and the current software development kit performs structural validation without document-signature verification. Signed Inspect is a planned enhancement, so Stage 1 must not encode signature absence as a permanent contract.                                                                                                                                                        | Current sources: `/Users/nxkavian/Drive/Source/AEP/aep-specs/ietf/schemas/inspect-document.schema.json:1`, `/Users/nxkavian/Drive/Source/AEP/aep-node/packages/core/src/inspect.ts:13`; future direction: user instruction in the active thread.                                                                                                                                            |
| Inspect Service reference                  | The positional input accepts `did:web` identifiers, hostnames, full protocol-neutral resource locators, and absolute URLs. Hostname forms infer HTTPS. All forms normalize to an origin; path, query, and fragment are discarded before network access, persistence, output, or error reporting. Explicit remote HTTP is rejected, while explicit loopback HTTP is accepted.                                                             | User instruction and Service-reference Option A in the active thread; `/Users/nxkavian/Drive/Source/AEP/aep-node/packages/agent/src/index.ts:1227`; `/Users/nxkavian/Drive/Source/AEP/aep-specs/ietf/specs/core/draft-kavian-agent-enrollment-protocol-01.md:130`                                                                                                                           |
| Inspect embedded credentials               | Service inputs containing URL username or password information are rejected as `AEP_SERVICE_REFERENCE_INVALID`; the input is never echoed.                                                                                                                                                                                                                                                                                               | User selected Option B in the active thread, 2026-07-09.                                                                                                                                                                                                                                                                                                                                    |
| AEP core handle                            | `Inflow` exposes a permanent `aep: IAep` handle beginning with authentication-independent `inspect()`. The handle uses low-level `aep-node` Inspect behavior in Stage 1 and is extended by later storage and lifecycle stages.                                                                                                                                                                                                           | User selected Option A in the active thread, 2026-07-09.                                                                                                                                                                                                                                                                                                                                    |
| AEP dependency ownership                   | `packages/core` declares `@aep-foundation/agent` as a peer and development dependency; `packages/cli` declares it as a runtime dependency. Integration uses a released npm version and follows the MPP and x402 pattern.                                                                                                                                                                                                                 | User instruction in the active thread; `packages/core/package.json:45`; `packages/cli/package.json:42`.                                                                                                                                                                                                                                                                                     |
| Stage 1 software development kit interface | `aep-node` adds `resolveAepServiceReference()`, optional Inspect `AbortSignal` and response-limit inputs, final accepted and normalized URLs, secure redirect and media behavior, bounded reading, and typed failures. Existing `serviceUrl` lifecycle properties remain unchanged.                                                                                                                                                      | User selected Option A in the active thread, 2026-07-09.                                                                                                                                                                                                                                                                                                                                    |
| Stage 1 specification scope                | `aep-specs` normatively requires the AEP media-type essence, prohibits automatic cross-origin Inspect redirects and HTTPS downgrade, and requires implementation-defined size and time limits. The patch preserves the planned signed-Inspect extension path.                                                                                                                                                                            | User selected Option A in the active thread, 2026-07-09.                                                                                                                                                                                                                                                                                                                                    |
| Stage 1 delivery sequence                  | Authority order is `aep-specs`, `aep-node`, then `inflow-cli`. Before `aep-node` publication, the built local Agent package is linked into `inflow-cli` through managed pnpm overrides for real cross-repository validation, then unlinked and replaced by the released npm version.                                                                                                                                                     | User selected Option A with a local-link checkpoint; existing mechanism: `scripts/link-local-inflow-node.mjs:1`.                                                                                                                                                                                                                                                                            |
| Local link workflow                        | The existing `link-local-inflow-node.mjs` and companion unlink script expand in place to manage `inflow-node` and `aep-node` through one marked pnpm override block. AEP linking covers `@aep-foundation/agent`, `@aep-foundation/core`, and `@aep-foundation/platform`, validates their built outputs, and uses `AEP_NODE_PATH` with the checked-out repository as its default target. No parallel AEP-specific scripts are introduced. | User instruction in the active thread; Agent dependency closure: `/Users/nxkavian/Drive/Source/AEP/aep-node/packages/agent/package.json:41`.                                                                                                                                                                                                                                                |
| Software development kit Inspect errors    | `inspectService()` maps known failures into one `AepInspectError` with a stable `reason` discriminator and reason-specific status or validation issues. Service normalization throws `AepServiceReferenceError`. Standard `cause` may retain internals, but CLI output never exposes it.                                                                                                                                                 | User selected Option A in the active thread, 2026-07-09.                                                                                                                                                                                                                                                                                                                                    |
| Stage 1 verification                       | Verification is layered across specification artifacts, software development kit unit tests, real loopback HTTP transport tests, core tests, CLI rendering and built integration tests, local linked-package validation, and final published-registry validation.                                                                                                                                                                        | User selected verification Option A in the active thread, 2026-07-09.                                                                                                                                                                                                                                                                                                                       |
| AEP storage interface                      | `AepStorage` composes typed identity and credential stores plus lifecycle clearing. Physical storage remains an implementation detail, allowing the initial JSON repository and later enterprise secret-store composition to share one flow contract. Inspect remains stateless in Stage 1, and incomplete Enroll operations are not persisted.                                                                                          | User selected the composed boundary, then explicitly rejected resumable operation storage in the active thread, 2026-07-10.                                                                                                                                                                                                                                                                 |
| AEP storage ownership                      | The initial store has one active owner identified by canonical Platform origin and `/v1/users/self` `userId`. No state is exposed before exact owner validation; malformed ownership fails closed; mismatch can replace old disposable state with an empty current-owner document.                                                                                                                                                       | User selected Option B in the active thread, 2026-07-10; `packages/core/src/types/index.ts:19`; `packages/core/src/resources/user.ts:16`.                                                                                                                                                                                                                                                   |
| AEP logout cleanup                         | Logout attempts remote token revocation and local AEP deletion, clears local InFlow auth in all cases, reports `aep_state_cleared`, and exits nonzero with `AEP_STATE_CLEAR_FAILED` when residual AEP state remains.                                                                                                                                                                                                                     | User selected Option B in the active thread, 2026-07-10.                                                                                                                                                                                                                                                                                                                                    |
| AEP authentication transition              | Successful same-owner login preserves AEP state. A different Platform-origin or `userId` triggers deletion after new credentials become durable. Cleanup failure leaves login successful, blocks AEP access, and reports `AEP_STATE_OWNER_TRANSITION_FAILED` with a nonzero exit.                                                                                                                                                        | User selected Option A in the active thread, 2026-07-10.                                                                                                                                                                                                                                                                                                                                    |
| Initial AEP file placement                 | The existing mode-`0o600` auth JSON gains a versioned `aep` subtree. Auth and AEP share one physical file and corruption domain but retain separate logical interfaces and clear operations.                                                                                                                                                                                                                                             | User selected Option B in the active thread, 2026-07-10; `packages/core/src/utils/storage.ts:26`.                                                                                                                                                                                                                                                                                           |
| AEP schema version                         | Only `aep.schemaVersion` versions local AEP state. It is an integer; missing or null AEP state is uninitialized; older supported versions migrate explicitly; unsupported newer versions fail closed.                                                                                                                                                                                                                                    | User selected Option A in the active thread, 2026-07-10.                                                                                                                                                                                                                                                                                                                                    |
| AEP identity collection                    | `aep.identities` is an object map keyed by canonical Service DID. Values are cloned, runtime-validated `AgentServiceIdentity` records whose contained Service DID matches the key; unknown metadata is preserved for evolution.                                                                                                                                                                                                          | User selected Option A in the active thread, 2026-07-10.                                                                                                                                                                                                                                                                                                                                    |
| Initial JSON concurrency                   | The current `conf`-backed file retains atomic individual writes and last-writer-wins cross-process behavior. No new lock, transaction framework, or concurrency dependency is added for the temporary implementation.                                                                                                                                                                                                                    | User instruction in the active thread, 2026-07-10; `conf` behavior: local package documentation and implementation.                                                                                                                                                                                                                                                                         |
| Enroll claim sourcing                      | Claims are sourced through user-approved InFlow disclosure initiated inside Platform delegated `sign(ENROLL)`. The software development kit must pass enrollment disclosure context through the signer boundary; the CLI waits for approval and then uses the signed assertion and approved claims for Service Enroll.                                                                                                                   | User correction in the active thread, 2026-07-10; current signer boundary: `/Users/nxkavian/Drive/Source/AEP/aep-node/packages/agent/src/index.ts:50`, `/Users/nxkavian/Drive/Source/AEP/aep-node/packages/agent/src/index.ts:739`; current Platform sign: `/Users/nxkavian/Drive/Source/InFlow/inflow-server/src/main/java/ai/inflowpay/aep/platform/service/AepPlatformService.java:111`. |
| Approval classification constraints        | `Approval.requesterId` and its derived `requester`/`seller` associations are nullable. Current `REGISTER` coupling is in the seller-authenticated request creation path and Register notification renderer. Reusing `REGISTER` for AEP is viable if those paths are refactored to present a Service DID and optional resolved InFlow requester rather than require a Seller.                                                             | `/Users/nxkavian/Drive/Source/InFlow/inflow-server/src/main/java/ai/inflowpay/datastore/model/Approval.java:88`; `/Users/nxkavian/Drive/Source/InFlow/inflow-server/src/main/java/ai/inflowpay/api/v1/controller/RequestController.java:168`; `/Users/nxkavian/Drive/Source/InFlow/inflow-server/src/main/java/ai/inflowpay/notification/email/RegisterApprovalEmail.java:16`.              |
| Enroll approval classification             | Initial Platform delegated `sign(ENROLL)` creates `ApprovalType.REGISTER`. The Approval persists the authoritative Service DID through `AepSignContext` and may carry a mapped InFlow `requesterId`; Register policy and presentation paths support both mapped and unmapped Services.                                                                                                                                                   | User selected Option A in the active thread, 2026-07-10.                                                                                                                                                                                                                                                                                                                                    |
| Enroll signing continuation                | Initial Sign atomically creates `AepSignContext` and the final `REGISTER` Approval, then returns pending `platform_context.approval_id`. The CLI polls generic Approval status inline and sends a separate final Sign request with that approval identifier. There is no cross-invocation resume.                                                                                                                                        | User consolidated authorization into Sign and rejected resume in the active thread, 2026-07-10.                                                                                                                                                                                                                                                                                             |
| Approval persistence normalization         | `AepSignContext` is a narrow child record keyed uniquely by `approvalId`; `ApprovalFlags.BIT_AEP` marks AEP-created Approvals. Approval remains the lifecycle authority. PolicySession and TransactionSession are not modified.                                                                                                                                                                                                          | User architecture decisions in the active thread, 2026-07-10.                                                                                                                                                                                                                                                                                                                               |
| Inspect JSON contract                      | Agent-mode output contains `schema_version`, the complete validated `document`, normalized and advertised-command-only URLs under `resolved`, and optional `cache_control` and `etag` fields under an always-present `response` object.                                                                                                                                                                                                  | User selected Option A in the active thread, 2026-07-09.                                                                                                                                                                                                                                                                                                                                    |
| Inspect cache behavior                     | Stage 1 performs a network fetch on every invocation, returns `Cache-Control` and `ETag` when supplied, creates no local cache, and exposes no refresh option.                                                                                                                                                                                                                                                                           | User selected Option A in the active thread, 2026-07-09.                                                                                                                                                                                                                                                                                                                                    |
| Inspect errors                             | Public codes are `AEP_SERVICE_URL_INVALID`, `AEP_INSPECT_NETWORK_ERROR`, `AEP_INSPECT_HTTP_ERROR`, `AEP_INSPECT_JSON_INVALID`, `AEP_INSPECT_DOCUMENT_INVALID`, `AEP_INSPECT_REDIRECT_REJECTED`, and `AEP_INSPECT_INTERNAL_ERROR`, with the approved retryability, sanitization, and exit-code rules.                                                                                                                                     | User selected error Option A and redirect Option B in the active thread, 2026-07-09.                                                                                                                                                                                                                                                                                                        |
| Inspect redirects                          | Redirects are processed manually, limited to five hops, and accepted only when scheme, hostname, and effective port match the current URL. Every target passes Service URL validation; downgrade and cross-origin targets are rejected.                                                                                                                                                                                                  | User selected Option B in the active thread, 2026-07-09.                                                                                                                                                                                                                                                                                                                                    |
| Inspect timeout                            | `--timeout` is a positive finite total-operation deadline in seconds, defaults to `30`, is capped at `300`, and maps expiration to retryable `AEP_INSPECT_TIMEOUT`; the software development kit accepts an `AbortSignal`.                                                                                                                                                                                                               | User selected Option B in the active thread, 2026-07-09.                                                                                                                                                                                                                                                                                                                                    |
| Cross-repository ownership                 | Reusable AEP protocol transport and validation belong in `aep-node`; normative interoperable behavior belongs in `aep-specs`; CLI product policy and presentation belong in `inflow-cli`.                                                                                                                                                                                                                                                | User instruction in the active thread, 2026-07-09.                                                                                                                                                                                                                                                                                                                                          |
| Inspect media type                         | Successful Inspect responses require the `application/aep+json` media-type essence. Media-type comparison is case-insensitive, valid parameters do not prevent acceptance, and missing, malformed, or different media types fail as `AEP_INSPECT_MEDIA_TYPE_INVALID`.                                                                                                                                                                    | User selected Option A in the active thread, 2026-07-09.                                                                                                                                                                                                                                                                                                                                    |
| Inspect response size                      | `aep-node` enforces a one-mebibyte decoded-body default while streaming, permits an application-level override, and exposes a typed oversized-response failure. `inflow-cli` uses the default with no public override and maps failure to `AEP_INSPECT_RESPONSE_TOO_LARGE`.                                                                                                                                                              | User selected Option C in the active thread, 2026-07-09.                                                                                                                                                                                                                                                                                                                                    |
| Inspect human output                       | Interactive output is a polished Service capability summary derived from the core envelope. It includes the copyable Service URL but shows neither Bindings, Inspect URL, HTTP response metadata, nor resolved command URLs; those remain available in agent-mode JSON.                                                                                                                                                                  | User approved modified Option A and clarified URL display in the active thread, 2026-07-09.                                                                                                                                                                                                                                                                                                 |
| Inspect authentication                     | AEP Inspect works logged out and does not receive auth storage, an InFlow Platform client, or an Authorization header. This matches `inflow mpp inspect`, whose CLI run path bypasses the session guard.                                                                                                                                                                                                                                 | `packages/cli/src/commands/mpp/index.tsx:599`; user instruction in the active thread.                                                                                                                                                                                                                                                                                                       |

## Completion Evidence

| Evidence                                                                                                                                        | Required? | Result    | Notes                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | --------- | --------- | ------------------------------------------------------------------------------------------------------------------------- |
| User approval of the `aep` command group and staged inclusion of every Agent-side operation.                                                    | Yes       | Confirmed | Public CLI scope.                                                                                                         |
| InFlow Server Platform discovery, endpoint paths, authentication boundary, and user scoping verified against implementation.                    | Yes       | Confirmed | Cross-repository boundary.                                                                                                |
| User approval of a dedicated storage interface, initial local JSON implementation, logout destruction, and final secure-store replacement task. | Yes       | Confirmed | Storage architecture direction; individual storage behaviors remain separate design topics.                               |
| Inspect command behavior covering inputs, transport, both output modes, exact JSON fields, exact errors, ownership, and verification.           | Yes       | Confirmed | Stage 1 design approved through individual user decisions.                                                                |
| Separate Enroll storage and command behavior specifications.                                                                                    | Yes       | Confirmed | Stage 2 contract, including repeat Enroll, output separation, and partial-success behavior.                               |
| Exact field-level CLI contracts for Enroll, Status, Grant, and Revoke.                                                                          | Yes       | Confirmed | User approved schemas, JSON fields, human projections, stable errors, and proactive expired-credential cleanup.           |
| Implementation task decomposition reviewed across the repositories.                                                                             | Yes       | Confirmed | Covers the five Service operations, supporting Platform/server work, storage, tests, documentation, and release ordering. |

## Ordered Task List

Current cursor: 120 Next task: Produce the implementation handoff for the five AEP Service operations

Status values: Not Started, In Progress, Blocked, Waiting On Decision, Done, Cut. Evidence types: Source, Test, Review,
Artifact, User Decision, External.

| Order | Status      | Priority | Lift | Task                                                                                                                                                                                | Owning specs        | Depends on   | Output                                                            | Verification                                                                         | User input needed             |
| ----- | ----------- | -------- | ---: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------- |
| 10    | Done        | P0       |    4 | Specify the stateless Inspect command and its core boundary.                                                                                                                        | Stage 1             | None         | Approved Inspect behavior contract.                               | Source, Review, and User Decision.                                                   | Yes, received.                |
| 12    | Done        | P0       |    4 | Specify required `aep-node` Inspect transport enhancements, including abort support, controlled redirects, final URL reporting, and typed failure boundaries.                       | Stage 1             | Task 10      | Upstream software development kit design and implementation task. | Source and User Decision; implementation verification remains in its delivery queue. | Yes, received.                |
| 14    | Done        | P1       |    3 | Review Stage 1 transport decisions for interoperable normative requirements and propose narrowly justified `aep-specs` changes.                                                     | Stage 1             | Task 10      | Approved focused specification scope.                             | Spec Review and User Decision.                                                       | Yes, received.                |
| 20    | Done        | P0       |    4 | Design the narrow local AEP storage interface and ownership boundary.                                                                                                               | Stage 2             | Task 10      | Approved composed storage and owner boundary.                     | Source, Review, and User Decision.                                                   | Yes, received.                |
| 30    | Done        | P0       |    4 | Design the initial single local JSON implementation, authenticated-user ownership, logout destruction, permissions, and concurrency behavior.                                       | Stage 2             | Task 20      | Approved bounded legacy JSON contract.                            | Review and User Decision.                                                            | Yes, received.                |
| 40    | Done        | P0       |    5 | Specify Enroll provisioning, persistence, Service command, retry, and partial-failure behavior.                                                                                     | Stage 2             | Tasks 20-30  | Approved Enroll behavior contract.                                | Source, Review, and User Decision.                                                   | Yes, received.                |
| 42    | Done        | P0       |    5 | Design InFlow Server approval-mediated delegated `sign(ENROLL)`, supported-claim mapping, Service-DID requester resolution, policy behavior, and signed/approved response contract. | Stage 2             | Task 40      | Approved server signing-disclosure contract.                      | Source, Review, and User Decision in `inflow-server`.                                | Yes, received.                |
| 44    | Done        | P0       |    4 | Design CLI delegated-sign polling, decline, timeout, interruption, and approved-claim handling without resume.                                                                      | Stage 2             | Task 42      | Approved asynchronous Enroll pipeline.                            | Source, Review, and User Decision.                                                   | Yes, received.                |
| 46    | Not Started | P2       |    4 | Refine the InFlow approval system to present and decide required, preferred, and optional AEP claim tiers distinctly.                                                               | Later enhancement   | Task 42      | Tier-aware approval and disclosure contract.                      | Source, Review, Test, and User Decision in `inflow-server`.                          | Yes.                          |
| 48    | Not Started | P2       |    4 | Design verified ownership, population, update, and removal lifecycle for Seller.serviceDid.                                                                                         | Later enhancement   | Task 42      | Seller Service-DID administration contract.                       | Source, Review, Test, and User Decision in `inflow-server`.                          | Yes.                          |
| 60    | Done        | P1       |    3 | Design Status as a separate stage.                                                                                                                                                  | Later stage         | Task 40      | Approved Status command contract.                                 | Source, Review, and prior User Decisions.                                            | No additional input required. |
| 70    | Done        | P1       |    4 | Design Grant and credential persistence as a separate stage.                                                                                                                        | Later stage         | Tasks 40, 60 | Approved Grant contract.                                          | Source, Review, and User Decision.                                                   | Yes, received.                |
| 80    | Done        | P1       |    4 | Design Revoke and local credential reconciliation as a separate stage.                                                                                                              | Later stage         | Task 70      | Approved Revoke contract.                                         | Source, Review, and User Decision.                                                   | Yes, received.                |
| 82    | Done        | P0       |    3 | Freeze exact CLI schemas, JSON fields, human projections, and stable error codes for Enroll, Status, Grant, and Revoke without changing their approved behavior.                    | CLI contract        | Tasks 40-80  | Field-level implementation contract.                              | Source, Review, Artifact, and User Decision.                                         | Yes, received.                |
| 110   | Done        | P1       |    4 | Replace the initial JSON implementation with an enterprise secure credential store behind the approved interface.                                                                   | Final storage stage | Tasks 20-80  | Delivered by Queue 2 Task 126 encrypted local vault daemon.       | Source, Review, Test, and signed debug binary evidence in Queue 2.                   | No.                           |
| 120   | Done        | P1       |    3 | Map dependencies, documentation, tests, Changesets, and verification for every designed stage.                                                                                      | All designed stages | Tasks 10-80  | Implementation-ready batch map.                                   | Artifact review.                                                                     | No.                           |

## Missed Or Hidden Work Found

- Item: The approved Status, Grant, Revoke, and portions of Enroll behavior are not yet frozen to the field-level CLI
  contract required by this repository: exact schema flags/defaults, agent JSON keys, human projections, and stable
  error code/message/exit behavior.
- Moved to: Ordered Task 82.
- Reason: Architecture and behavior are approved, but implementation and contract tests require exact shapes. This task
  must derive names and patterns from existing MPP/x402 commands and the AEP wire types without inventing new commands.
- Date: 2026-07-10

- Item: The software development kit needs abort support, controlled redirect behavior, final accepted URL reporting,
  and typed error boundaries to keep protocol transport out of `inflow-cli`.
- Moved to: Ordered Task 12.
- Reason: This is required by approved Stage 1 behavior and belongs at the reusable software development kit boundary.
- Date: 2026-07-09

- Item: Approved transport rules must be reviewed for normative protocol requirements rather than being encoded only as
  one CLI's product policy.
- Moved to: Ordered Task 14.
- Reason: Interoperable security requirements belong in `aep-specs` when justified.
- Date: 2026-07-09

- Item: Enroll claims require approval-mediated InFlow Server delegated `sign(ENROLL)`, a supported AEP-claim mapping,
  Service-DID requester resolution, approval presentation, and an asynchronous signed/approved response contract.
- Moved to: Ordered Task 42.
- Reason: This replaces direct CLI claim entry and is required to complete Enroll with explicit user consent.
- Date: 2026-07-10

- Item: The CLI needs an approval-driven Enroll pipeline with inline polling in both agent and human modes.
- Moved to: Ordered Task 44.
- Reason: Claim disclosure is asynchronous and must follow the established approval interaction pattern.
- Date: 2026-07-10

- Item: The approval system should eventually present and decide required, preferred, and optional AEP claims as
  distinct tiers rather than one all-or-nothing supported set.
- Moved to: Ordered Task 46.
- Reason: The current flow intentionally requests all advertised tiers, while tier-aware approval requires a separate
  presentation, policy, persistence, and response contract.
- Date: 2026-07-10

- Item: Seller.serviceDid needs a verified ownership and population lifecycle.
- Moved to: Ordered Task 48.
- Reason: Lookup is required now, while population was explicitly deferred by the user and must not be inferred from
  Seller website or hostname.
- Date: 2026-07-10

- Item: The core specification and broader onboarding design use `verification_pending` for pending Enroll verification,
  while the current AEP Node `EnrollResponse`, parser, and schema use `requirements_pending`.
- Moved to: Stage 2 `aep-specs` and `aep-node` compatibility batch.
- Reason: `verification_pending` and `requirements_pending` have different meanings. The software development kit must
  preserve Enroll verification separately from Status requirements before the CLI returns the full response.
- Date: 2026-07-10

- Item: Current AEP Node Platform Sign is synchronous, has no `platform_context`, pending response variant, or
  Idempotency-Key header, and its delegated signer returns only a string assertion.
- Moved to: Stage 2 `aep-specs` and `aep-node` Platform Sign batch.
- Reason: Approval-backed ENROLL and GRANT require a generic asynchronous continuation contract without making the
  software development kit InFlow-specific; STATUS and REVOKE still complete synchronously.
- Date: 2026-07-10

## Risk Register

| Risk                                                                       | Impact                                                                                     | Mitigation                                                                                                                                                                | Status                              |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Reusing an InFlow credential with the wrong Platform audience.             | Identity provisioning or signing fails, or credentials are sent to an unauthorized origin. | Verify endpoint ownership, audience, and accepted auth scheme before design approval.                                                                                     | Open                                |
| Using the Agent package's in-memory defaults.                              | Identities and credentials disappear between CLI invocations.                              | Supply durable store implementations in core.                                                                                                                             | Open                                |
| Local AEP state survives logout or crosses an authenticated-user boundary. | A later user could access another user's Agent identities or Service credentials.          | Bind the local state to the logged-in user and destroy it during logout before another principal can use it.                                                              | Open                                |
| Printing issued credentials by default.                                    | Secrets can enter transcripts, logs, and Model Context Protocol results.                   | Grant stores the complete credential but returns only non-secret action metadata; Status returns only non-secret local grant summaries.                                   | Mitigated by design                 |
| Concurrent processes write the temporary shared JSON config.               | Last-writer-wins can lose an auth or AEP update.                                           | Treat the JSON backend as a bounded bridge, document the limitation, avoid claiming cross-process durability, and resolve concurrency in the final enterprise-store task. | Accepted for initial implementation |

## Source Audit Findings

1. Actual contradiction: The AEP core draft and broader onboarding design use `verification_pending` for incomplete
   asynchronous Enroll verification, while the current AEP Node Enroll type, parser, and schema use
   `requirements_pending`. Status uses `requirements_pending` for requirements the Agent still needs to satisfy. These
   fields are not synonyms; Batch 5 corrects AEP Node without rewriting the specification meaning.
2. Lifetime correction: The earlier 24-hour stale AEP signing-context retention exceeded the 900-second pending Approval
   lifetime and came from an inapplicable generic session analogy. Unfinished or orphaned AepSignContext cleanup is
   bounded to 900 seconds. The one-hour Platform idempotency cache is intentionally separate because AEP requires at
   least one hour of replay protection.

## Implementation Batch Map

| Batch                                     | Repository                         | Depends on                          | Purpose                                                                                                                                                                                                                                                                          | Required verification                                                                                |
| ----------------------------------------- | ---------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1. Inspect specification                  | `aep-specs`                        | None                                | Normative Inspect media type, redirect trust, and bounded transport requirements.                                                                                                                                                                                                | IETF render, format, idnits, schemas, examples, and repository checks.                               |
| 2. Inspect software development kit       | `aep-node`                         | Batch 1                             | Additive Service-reference resolution, abort, redirects, response bounds, final URL, and typed errors.                                                                                                                                                                           | `pnpm verify`, `pnpm check-publish`, package tests, and Changeset.                                   |
| 3. Inspect CLI                            | `inflow-cli`                       | Batch 2 release or local link       | Add `inflow.aep.inspect`, command schema, exact JSON, polished human rendering, tests, docs, and Changeset.                                                                                                                                                                      | Typecheck, lint, test, TypeDoc, build, integration tests, and publish dry run.                       |
| 4. Platform Sign specification            | `aep-specs`                        | Inspect contracts                   | Add optional unsigned `platform_context`, header-only Platform idempotency, completed/pending Sign union, retry seconds, hosted-verification idempotency, and explicit operation policy extension behavior. Preserve distinct Enroll verification and Status requirement fields. | Full IETF checks and updated examples/test vectors.                                                  |
| 5. Platform Sign software development kit | `aep-node`                         | Batch 4                             | Extend Platform request/response types and delegated signer flow for pending continuation and approved claims without InFlow-specific fields.                                                                                                                                    | `pnpm verify`, `pnpm check-publish`, focused Agent/Platform tests, and Changeset.                    |
| 6. InFlow Server AEP approval             | `inflow-server`                    | Batches 4-5 contract                | Implement shared idempotency cache, operation-aware Sign, `AepClaim`/`AepClaims`, `AepSignContext`, BIT_AEP, REGISTER refactor, Seller.serviceDid lookup, cleanup, and final approved claims.                                                                                    | Formatter, Checkstyle/static analysis, unit tests, integration tests, migrations, and JaCoCo review. |
| 7. CLI storage foundation                 | `inflow-cli`                       | Existing auth storage               | Add composed typed `AepStorage`, owner isolation, temporary JSON subtree, logout/auth-transition cleanup, migrations, and tests.                                                                                                                                                 | Full CLI gate plus file-permission and ownership-transition tests.                                   |
| 8. CLI Enroll                             | `inflow-cli`                       | Batches 5-7 and server availability | Add Enroll orchestration, inline Approval polling, exact full JSON response, concise human rendering, repeat-Enroll identity reuse, interruption cleanup, and partial-success errors.                                                                                            | Full CLI gate, local linked end-to-end validation, docs, and Changeset.                              |
| 9. Remaining Service operations           | All applicable repositories        | Batch 8                             | Deliver Status, Grant, and Revoke in specification order with the approved direct-sign and approval policies.                                                                                                                                                                    | Per-repository full gates and cross-repository integration tests.                                    |
| 10. Enterprise storage                    | `inflow-cli` plus selected backend | Credential-producing stages         | Replace temporary JSON behind `AepStorage` with transactional secure custody and migration.                                                                                                                                                                                      | Threat review, migration/recovery tests, concurrency tests, full CLI gate.                           |

## Blocked Task Protocol

Blocked tasks must include the blocking condition, attempted resolution, decision needed, and next unblock action.

## Queue Closure Rules

Do not close this queue until:

- Every task is Done, Cut with rationale, or moved to another queue or planning document.
- Missed Or Hidden Work Found is empty, promoted, cut with rationale, or moved.
- Decision Points are resolved, cut with rationale, or moved.
- Completion Evidence is satisfied.
- Final Handoff is complete.

Do not reorder, reprioritize, or cut tasks without recording the reason. Ask the user before changing P0 or P1 priority
unless it is a blocker carve-out.

## Final Handoff

- Summary: The AEP Agent CLI architecture and exact contracts are complete for Inspect, Enroll, Status, Grant, and
  Revoke. `_PLAN1.md` indexes separate repository implementation plans for aep-specs, aep-node, inflow-server, and
  inflow-cli so execution can use repository-scoped writable tasks.
- Completed tasks: 10, 12, 14, 20, 30, 40, 42, 44, 60, 70, 80, 82, and 120.
- Cut or deferred tasks and where they moved: Tasks 46 and 48 remain parked in this queue by user instruction. Task 110
  was delivered by Queue 2 Task 126.
- Decisions resolved: Public command surface, transport, storage, Platform Sign, Approval, claim disclosure, output,
  error, expiry, idempotency, cleanup, and release-order contracts.
- Completion evidence: Decision log, source-backed state, completion-evidence table, implementation batch map,
  `_PLAN1.md`, and the four repository-specific plans.
- Remaining risks: Temporary JSON last-writer-wins behavior, future Seller Service-DID population, tier-flattened
  Approval presentation, and later enterprise credential custody.
- Files changed: `_QUEUE1.md`, `_PLAN1.md`, `_PLAN1-AEP-SPECS.md`, `_PLAN2-AEP-NODE.md`, `_PLAN3-INFLOW-SERVER.md`, and
  `_PLAN4-INFLOW-CLI.md`.

## Working Rules For This Queue

- Check the source before relying on a boundary.
- Keep source-backed state separate from target design.
- Update task status as work progresses.
- Include the Active Focus Window and the single next action in every status update, pause point, handoff, or final
  control-return message.
- Apply the No Buried Work Rule before every status update, pause point, handoff, or final control-return message.
- Record discovered work immediately under Missed Or Hidden Work Found and promote it only with user approval, explicit
  scope confirmation, or a blocker carve-out.
- Break tasks with lift higher than 5 into smaller tasks.
- Do not use this file as a changelog.
- Report blockers with Question, Context, Examples, Options, Recommendation, and Consequence of deferring.

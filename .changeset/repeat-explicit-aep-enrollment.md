---
'@inflowpayai/inflow': patch
---

Send explicitly repeated AEP enrollments through approval to the Service instead of returning its existing status.
Preserve the existing Agent identity and let the Service decide how to apply the approved claims. Request human approval
for required Service documents and submit only the document identifiers returned by InFlow after approval. Display
document links while waiting for approval and expose acknowledged identifiers in the enrollment response schema. Report
unmet Service requirements with document IDs and explicit Enroll guidance, without automatically enrolling or retrying
Grant.

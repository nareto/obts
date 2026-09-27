---------------- MODULE OBTSDiagnosticAdmission ----------------
EXTENDS Naturals, FiniteSets, TLC

(***************************************************************************
FM007, revision 23. Aggregate admission for clients sharing one owner/instance.
Three automatic and three manual IDs; each quota scales to total 3
with manual reserve 1. Pending requests may race; Accept is the serialized
metadata seam. One acceptance-window expiry and storage expiry are independent.
Reusing an expired stored ID creates a distinct acceptance token. Connection
report 3 claims manual but retains its admission lane after enrollment.
No HTTP, filesystem durability, physical/nested clocks, startup reconstruction,
legacy saturation, queue latency or sender conformance claim is made.
***************************************************************************)
CONSTANT Mutation
VARIABLE rows, hourly, pending, expiredHour, expiredRows, charged, rejected, enrolled
vars == <<rows, hourly, pending, expiredHour, expiredRows, charged, rejected, enrolled>>
Events == 1..6
Manual == (4..6) \cup (10..12) \cup
  (IF enrolled /\ Mutation = "promote-connection" THEN {3, 9} ELSE {})
Auto == (1..12) \ Manual
Lane(e) == IF e \in Manual THEN Manual ELSE Auto
Limit(e) == IF e \in Manual THEN 1 ELSE 2
Fits(set, e) == Cardinality(set \cap Lane(e)) < Limit(e)
CanAccept(e) == IF Mutation = "legacy-shared" THEN
  Cardinality(hourly) < 3 /\ Cardinality(rows) < 3
  ELSE Fits(hourly, e) /\ Fits(rows, e)
Init == /\ rows = {} /\ hourly = {} /\ pending = {}
  /\ expiredHour = FALSE /\ expiredRows = FALSE /\ charged = 0 /\ rejected = FALSE /\ enrolled = FALSE
Request(e) == /\ e \notin pending /\ pending' = pending \cup {e}
  /\ UNCHANGED <<rows, hourly, expiredHour, expiredRows, charged, rejected, enrolled>>
Accept(e) == /\ e \in pending /\ e \notin rows /\ CanAccept(e)
  /\ rows' = rows \cup {e}
  /\ hourly' = hourly \cup {IF expiredRows THEN e + 6 ELSE e}
  /\ charged' = Cardinality(hourly') /\ pending' = pending \ {e}
  /\ UNCHANGED <<expiredHour, expiredRows, rejected, enrolled>>
Duplicate(e) == /\ e \in pending /\ e \in rows
  /\ pending' = pending \ {e}
  /\ charged' = (IF Mutation = "charge-duplicate" THEN charged + 1 ELSE charged)
  /\ UNCHANGED <<rows, hourly, expiredHour, expiredRows, rejected, enrolled>>
Reject(e) == /\ e \in pending /\ e \notin rows /\ ~CanAccept(e)
  /\ pending' = pending \ {e} /\ rejected' = TRUE
  /\ charged' = (IF Mutation = "charge-rejected" THEN charged + 1 ELSE charged)
  /\ UNCHANGED <<rows, hourly, expiredHour, expiredRows, enrolled>>
ExpireHour == /\ ~expiredHour /\ hourly' = {} /\ charged' = 0
  /\ expiredHour' = TRUE /\ UNCHANGED <<rows, pending, expiredRows, rejected, enrolled>>
ExpireRows == /\ ~expiredRows /\ rows' = {} /\ expiredRows' = TRUE
  /\ UNCHANGED <<hourly, pending, expiredHour, charged, rejected, enrolled>>
Enroll == /\ ~enrolled /\ 3 \in rows /\ enrolled' = TRUE
  /\ UNCHANGED <<rows, hourly, pending, expiredHour, expiredRows, charged, rejected>>
Next == (\E e \in Events: Request(e) \/ Accept(e) \/ Duplicate(e) \/ Reject(e))
  \/ ExpireHour \/ ExpireRows \/ Enroll
FiniteCaps == Cardinality(rows) <= 3 /\ Cardinality(hourly) <= 3
AcceptanceOnly == charged = Cardinality(hourly)
ManualAvailable == (rows \cap Manual = {} /\ hourly \cap Manual = {}) => CanAccept(4)
Partitions == Cardinality(rows \cap Auto) <= 2 /\ Cardinality(rows \cap Manual) <= 1
  /\ Cardinality(hourly \cap Auto) <= 2 /\ Cardinality(hourly \cap Manual) <= 1
ConnectionLanePreserved == 3 \notin Manual
Safety == FiniteCaps /\ AcceptanceOnly /\ ManualAvailable /\ Partitions /\ ConnectionLanePreserved
NeverSaturatedThenManual == ~(Cardinality(rows \cap Auto) = 2 /\ Cardinality(rows \cap Manual) = 1)
NeverExpired == ~(expiredHour /\ expiredRows /\ rows # {} /\ hourly # {})
Spec == Init /\ [][Next]_vars
=============================================================================

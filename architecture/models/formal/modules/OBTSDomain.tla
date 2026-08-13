---- MODULE OBTSDomain ----
EXTENDS Naturals, FiniteSets, Sequences, TLC

(***************************************************************************
Pure finite-domain helpers for OBTS-FM-002. This module defines no Spec.
Version values denote exact bytes plus path identity and provenance.
***************************************************************************)

Bool == {TRUE, FALSE}

SetMap(domain, value) == [x \in domain |-> value]

ReplaceAt(map, key, value) == [map EXCEPT ![key] = value]

ReplaceNested(map, outer, inner, value) ==
  [map EXCEPT ![outer][inner] = value]

InRange(value, map, domain) == \E key \in domain: map[key] = value

Monotonic(old, new) == old <= new

=============================================================================

---
id: ubiquitous-language-in-code
title: Code Uses the Domain's Ubiquitous Language
severity: convention
scope:
  layers:
    - domain
tags:
  - ddd
  - naming
  - domain-modeling
---

Variable names, class names, method names, and module names in domain code must use the ubiquitous language of the bounded context — the exact terms domain experts use in conversation. No abbreviations, no technical synonyms, no invented terms. If the business says "Policy" don't call it "Rule." If they say "Claim" don't call it "Request." If they say "underwrite" don't call it "evaluate." The code should read like a domain expert wrote it.

## Rationale

*Implementing Domain-Driven Design* and *Learning Domain-Driven Design* both establish that the ubiquitous language is the bridge between domain experts and developers. When code uses different terminology than the business, every conversation requires mental translation: "when you say 'Rule' do you mean what we call a 'Policy'?" This friction compounds over time — new team members learn the code's terminology, which differs from what the business says, and the gap between what the software does and what the business thinks it does widens silently.

This complements `naming-reveals-intent` (which is about general naming clarity). This principle is specifically about semantic alignment with the domain: not "is this name clear?" but "is this name the same word the domain expert would use?"

The failure mode: the codebase uses `UserAccount` but the business says "Membership." A domain expert says "when a Membership is suspended, pending Claims should be held." A developer searches for "Membership" in the code and finds nothing. They search for "suspended" and find a method called `deactivateAccount()`. They search for "Claim" and find `ServiceRequest`. Every requirement maps to different code terms, and the translation is tribal knowledge that lives in one senior developer's head.

## Examples

**Bad — technical or invented terms instead of domain language:**

```typescript
// Insurance domain — code uses generic/technical terms
class ServiceRequest {              // Domain calls this a "Claim"
  requestType: string;              // Domain calls this "claim type"
  evaluationStatus: string;         // Domain calls this "adjudication status"

  async evaluate(): Promise<void> { // Domain says "adjudicate a claim"
    if (this.checkRules()) {        // Domain says "apply underwriting guidelines"
      this.updateStatus("approved");
    }
  }
}

class UserAccount {                 // Domain calls this "Policyholder"
  accountPlan: Plan;                // Domain calls this "Policy"
}
```

**Good — code uses the domain's language:**

```typescript
// Insurance domain — code mirrors how domain experts speak
class Claim {
  claimType: ClaimType;
  adjudicationStatus: AdjudicationStatus;

  async adjudicate(guidelines: UnderwritingGuidelines): Promise<AdjudicationResult> {
    const ruling = guidelines.applyTo(this);
    return this.recordRuling(ruling);
  }
}

class Policyholder {
  policy: Policy;

  suspend(): void {
    this.policy.markSuspended();
    // "When a Policyholder is suspended" → maps directly to requirements
  }
}
```

A domain expert reading the good example can follow the code without translation. "Adjudicate a claim using underwriting guidelines" reads like their specification.

## Exceptions

Technical infrastructure code (database connections, HTTP clients, logging, serialization) does not need domain language — it has no domain. Well-established programming patterns (`Repository`, `Factory`, `Service`, `Controller`) are acceptable as suffixes even if domain experts wouldn't use them — `ClaimRepository` clearly means "the thing that stores Claims." Abbreviations universally understood in the domain (SKU, ETA, VIN) are acceptable if the domain experts themselves use them.

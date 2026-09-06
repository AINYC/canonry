# Why we use model providers' APIs directly (not a router)

Canonry measures how AI answers mention your brand and cite your website.
Direct provider adapters keep answer capture, mention measurement, and citation
evidence explicit. Each adapter defines the request policy and reads the
provider's evidence.
A model catalog alone cannot establish that measurement contract.

## The measurement is more than the model

A visibility observation depends on the model, search tool, request policy,
location treatment, and returned evidence. The same model name through a
different API does not prove equivalent behavior.

Canonry keeps answer mentions separate from source citations. A model can name
a brand without citing its website. Retrieved pages are also distinct from
sources that support the final answer.

Direct adapters preserve evidence that their provider returns. For example,
the Gemini adapter retains grounding chunks, answer-support mappings, and
issued search queries. These fields help explain a visibility change.
Not every provider returns every field. Missing evidence is not proof of zero
visibility. The [provider guides](README.md#provider-specific-documentation)
describe these differences.

## Why direct APIs instead of model routers

Model routers offer broad model access through a shared API. API compatibility alone does not
prove equivalent answer and citation measurements.

A model router integration needs explicit checks for model selection, request
translation, search behavior, and fallback policies. It also needs to preserve
answer text, available source evidence, and returned model identity.

These checks matter for both signals. A change in the request or search context
can affect which brands an answer mentions and which websites it cites.

Canonry uses direct provider adapters for visibility sweeps. This decision does
not mean that model routers cannot support grounded answers. A router-based
measurement needs its own evidence contract and baseline, not a direct-provider
label.

## How we choose a model

The selection criteria cover the complete provider request, not general
reasoning scores alone:

1. **Answer capture:** the adapter preserves final answer text for separate
   brand and competitor mention measurement.
2. **Search support:** the model supports the adapter's retrieval tool and
   request controls.
3. **Citation evidence:** the response distinguishes final-answer citations
   from retrieved sources and links written in plain text.
4. **Diagnostic evidence:** the adapter retains available search queries,
   source metadata, and model identity, with explicit limits for absent fields.
5. **Location treatment:** the adapter documents whether location uses a
   structured request field, prompt context, or no supported control.
6. **Operating cost:** token cost, search cost, latency, and quotas permit
   repeated measurements at the intended scale.
7. **Regression coverage:** request and parser tests cover answer mentions,
   source citations, missing evidence, and provider errors.

Provider defaults and known-model lists remain explicit in each adapter.
Some adapters also accept custom model IDs. An accepted ID or successful text
completion does not certify the full measurement contract. Model changes need
a review of the evidence contract and historical comparability.

## Richer evidence for visibility measurement

Direct adapters let Canonry control each request and retain the provider's
available search details and source evidence. This detail helps explain why
brand mentions or website citations change. Each adapter has its own provider
key and tests for the evidence it records.

Direct APIs do not guarantee identical answers across runs. They also do not
reproduce the consumer ChatGPT, Claude, or Gemini applications. Browser
measurements use a separate adapter. Local models have their own documented
evidence limits.

## The same rules for both portfolio types

Simple portfolios and Advanced Measurement portfolios use the same provider
evidence rules. Advanced Measurement retains Property, Target, market,
provider, and query-class scope. An aggregate does not upgrade missing evidence
or make different measurement methods interchangeable.

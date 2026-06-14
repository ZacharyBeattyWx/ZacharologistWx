# ZacharologistWx Level II Scanner Lambda

This Lambda is the event-driven Level II radar scanner.

Current production chain:

AWS SQS/SNS Level II source event
? Lambda extracts radar site/source key
? DynamoDB cooldown lock prevents duplicate same-site dispatches
? Lambda calls Cloudflare `/level2-scan`
? Cloudflare sends GitHub `repository_dispatch`
? GitHub Actions renders `radar_level2_scan`

Professional target:

AWS Lambda
? direct GitHub `repository_dispatch`
? GitHub Actions render

Planned improvements:
- keep event-driven dispatch
- add stale-site watchdog sweep
- track scanner state in DynamoDB
- remove Cloudflare from Level II dispatch path after direct dispatch is proven
# Design and Decisions

### Main entry point
- Amazon Connect is the entry point for the vanity generator. When the Connect instance is called, Connect routes to the main lambda and hands off the work.

### Main Lambda
- The call processing happens here. When a call comes through from connect, the number is read, split into fragments, and the potential letters the number can represent are matched to a list of ~800 words. the larger the word is, the higher it will rank. 1-800-BURGERS will rank over 1-800-BURG3AS 
- The top 5 highest scoring candidates are stored in DynamoDB along with additional information including a timestamp, keyed by the callerId.
- The top 3 highest scoring candidates are read aloud back to the caller.

### Dashboard entry point
- A simple HTTP API Gateway linked to lambda is the entry point for the dashboard. I opted for HTTP instead of REST since for our use case as we dont need any of the extra features REST offers and HTTP lowers costs.

### Dashboard Lambda
- Scans the VanityNumbers table, sorting results by timestamp decending.
- Deduplicates by CallerId keeping the most recent record.
- Returns the top 5 scorers as JSON, polling every 30s. Polling was chosen for simpler and cheaper architecture while not impacting function.

### Dashboard webhost
- The dashboard is hosted as a single static HTML file in S3. The bucket is only exposed through Cloudfront via an origin access control policy for security.
- Cloudfront also handles authentication. The Cloudfront function in front of the site decodes the Authorization header and compares the value to stored user / pass hardcoded into the function. 

### Questions I would ask a client
- how long should data be kept in the database history? (I went with indefinite TTL)
- how should we handle authentication? (I went with a single admin auth)
- should duplicate entries be stored, or is it one entry per number? (I went with one entry per number)

### If I had more time
- I would switch from hardcoded one-time auth to Cognito for stronger security features and multiple accounts for dashboard login.
- I would add an option to generate a new set of vanity numbers.
- add number substitutes (example 3 instead of e) as slightly lower value matches to dictionary

### Misc
- Chose serverless architecture for much lower costs.
- 
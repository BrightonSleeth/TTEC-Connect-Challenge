# How to use

### Dashboard
- Visit https://da4typxk42hr5.cloudfront.net
- Calls are listed from newest to oldest along with their 5 generated vanity numbers.

### Connect 
- Call 1 (213) 529-1863.
- Your top 3 vanity numbers will be read aloud to you.

### CDK
- Navigate to vanity-cdk folder and read instructions provided there.

# Design and Decisions

### Main entry point
- Amazon Connect is the entry point for the vanity generator. When the Connect instance is called, Connect routes to the main lambda and reads out the response generated.
- New results will only be generated if the caller doesnt have an entry in Dynamo yet. Otherwise old results will be retrieved instead.

### Main Lambda
- The call processing happens here. When a call comes through from connect, the number is read, split into fragments, and the potential letters the number can represent are matched to an on board list of words. the larger the word is, the higher it will score. 1-800-BURGERS will rank over 1-800-BURGER7 
- The top 5 highest scoring candidates are stored in DynamoDB along with additional information including a timestamp, keyed by the callerId.
- The top 3 highest scoring candidates are read aloud back to the caller.

### Dashboard Lambda
- Scans the VanityNumbers table, sorting results by timestamp decending.
- Deduplicates by CallerId keeping the most recent record.
- Returns the top 5 scorers as JSON, polling every 30s. Polling was chosen for simpler and cheaper architecture then live while not impacting function.

### Dashboard webhost
- The dashboard is hosted as a single static HTML file in S3, with the data hooked in from an HTTP API into the dashboard Lambda. The bucket is only exposed through Cloudfront.

### Questions I would ask a client
- how long should data be kept in the database history? (I went with indefinite TTL)
- how should we handle authentication? (I went with no auth for now)

### If I had more time
- I would integrate authentication.
- I would add an option to select one of the generated numbers and set it as "preferred."
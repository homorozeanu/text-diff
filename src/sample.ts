/** Example texts for the "Sample" button. */

export const SAMPLE_ORIGINAL = `# Deployment checklist

1. Run the unit tests
2. Build the release bundle
3. Upload the bundle to the staging server
4. Notify the QA team

server:
  host: staging.example.com
  port: 8080
  timeout: 30
  retries: 3

function greet(name) {
  console.log("Hello, " + name);
}
`;

export const SAMPLE_CHANGED = `# Deployment checklist

1. Run the unit and integration tests
2. Build the release bundle
3. Upload the bundle to the production server
4. Tag the release in git
5. Notify the QA team

server:
  host: prod.example.com
  port: 8443
  timeout: 30
  tls: true

function greet(name, greeting = "Hello") {
  console.log(greeting + ", " + name + "!");
}
`;

{{#each servers}}{{#if hasInstructions}}<{{name}}>
{{instructions}}
</{{name}}>

{{/if}}{{/each}}Tools are namespaced by server as `{server}_{tool}`.
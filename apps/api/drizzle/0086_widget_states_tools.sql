alter table agent_widgets
  -- named spec variants selected by "state" in the WIDGET_REF data —
  -- a component renders differently per outcome (in transit vs not found)
  add column states jsonb,
  -- tool binding: referencing the widget calls the tool with the ref's
  -- data as args and maps the JSON result into {prop} placeholders /
  -- list items — the component IS the tool invocation
  add column tool jsonb;

//! Catalog-aware ALLEN source checker for SHOUT skills.
//!
//! `allen check` compiles against an empty tool catalog, and JOSH `program/load`
//! reports only a sanitized failure. SHOUT needs the compiler's real diagnostics
//! for a skill that calls SHOUT's frozen host tools, plus the entry boundary type
//! so it can build the entry input. This uses the same compiler path as JOSH.
//!
//! Usage: `shout-allen-check <catalog.json>` with ALLEN source on stdin.
//! Prints one JSON object on stdout and exits 0 unless its own inputs are invalid.

use allen_bytecode::ValueType;
use allen_compiler::{Diagnostic, assemble_inline_source, compile_inline_manifest_source_with_catalog};
use josh_protocol::{CatalogSetParams, Validate as _};
use serde_json::{Value, json};
use std::io::Read as _;
use std::process::ExitCode;

fn main() -> ExitCode {
    let Some(catalog_path) = std::env::args().nth(1) else {
        eprintln!("usage: shout-allen-check <catalog.json> < source.allen");
        return ExitCode::from(2);
    };
    let catalog = match read_catalog(&catalog_path) {
        Ok(catalog) => catalog,
        Err(message) => {
            eprintln!("{catalog_path}: {message}");
            return ExitCode::from(2);
        }
    };
    let mut source = String::new();
    const LIMIT: usize = 1024 * 1024;
    if std::io::stdin().take(LIMIT as u64 + 1).read_to_string(&mut source).is_err() {
        eprintln!("source must be UTF-8");
        return ExitCode::from(2);
    }
    if source.len() > LIMIT {
        eprintln!("source exceeds 1 MiB");
        return ExitCode::from(2);
    }
    println!("{}", check(&source, &catalog));
    ExitCode::SUCCESS
}

fn check(source: &str, catalog: &allen_schema::FrozenCatalog) -> Value {
    let (manifest, compilation, _) = match compile_inline_manifest_source_with_catalog(source, catalog) {
        Ok(compiled) => compiled,
        Err(diagnostics) => {
            return json!({ "ok": false, "diagnostics": diagnostics.iter().map(|d| diagnostic(source, d)).collect::<Vec<_>>() });
        }
    };
    let Some(manifest) = manifest else {
        return json!({ "ok": false, "diagnostics": [{ "line": 1, "column": 1, "code": "SHOUT001",
            "message": "a skill must begin with an inline manifest { ... } block" }] });
    };
    let entry = compilation.exported_functions.iter().find(|function| function.function == manifest.entry);
    let entry = entry.map(|function| json!({
        "name": function.function,
        "input": function.parameter_types.first().map_or(json!({ "type": "void" }), describe),
        "input_spelling": function.parameter_spellings.first(),
        "output": describe(&function.return_type),
        "output_spelling": function.return_spelling,
        "effects": function.effects,
    }));
    // Final assembly applies boundary rules the front end does not, such as the
    // one-parameter entry limit and non-serializable boundary types.
    if let Err(message) = assemble_inline_source(source, catalog) {
        return json!({ "ok": false, "entry": entry, "diagnostics": [{ "line": 1, "column": 1, "code": "SHOUT002", "message": message }] });
    }
    json!({
        "ok": true,
        "diagnostics": [],
        "entry": entry,
        "capabilities": manifest.capabilities,
        "tools": manifest.tools.iter().map(|tool| tool.name.as_str().to_owned()).collect::<Vec<_>>(),
    })
}

fn describe(value_type: &ValueType) -> Value {
    match value_type {
        ValueType::Unit => json!({ "type": "void" }),
        ValueType::Bool => json!({ "type": "bool" }),
        ValueType::Int => json!({ "type": "int" }),
        ValueType::Float => json!({ "type": "float" }),
        ValueType::String => json!({ "type": "string" }),
        ValueType::List(item) => json!({ "type": "list", "items": describe(item) }),
        ValueType::Option(value) => json!({ "type": "option", "value": describe(value) }),
        ValueType::Result(ok, err) => json!({ "type": "result", "ok": describe(ok), "err": describe(err) }),
        ValueType::Newtype { underlying, .. } => describe(underlying),
        ValueType::Record(fields) => json!({ "type": "record", "fields": fields.iter()
            .map(|field| (field.name.clone(), describe(&field.value_type))).collect::<serde_json::Map<_, _>>() }),
        ValueType::Map(key, value) => json!({ "type": "map", "key": describe(key), "value": describe(value) }),
        _ => json!({ "type": "other" }),
    }
}

fn diagnostic(source: &str, diagnostic: &Diagnostic) -> Value {
    let offset = diagnostic.span.start.min(source.len());
    let (mut line, mut line_start) = (1, 0);
    for (index, byte) in source.as_bytes()[..offset].iter().enumerate() {
        if *byte == b'\n' {
            line += 1;
            line_start = index + 1;
        }
    }
    let column = source.get(line_start..offset).map_or(1, |text| text.chars().count() + 1);
    json!({ "line": line, "column": column, "code": diagnostic.code, "message": diagnostic.message })
}

fn read_catalog(path: &str) -> Result<allen_schema::FrozenCatalog, String> {
    let json = std::fs::read_to_string(path).map_err(|error| format!("cannot read catalog: {error}"))?;
    let params: CatalogSetParams = serde_json::from_str(&json).map_err(|error| format!("invalid catalog: {error}"))?;
    params.validate().map_err(|_| "invalid catalog".to_owned())?;
    let limits = allen_schema::SchemaLimits::default();
    let tools = params.tools.iter().map(|tool| {
        allen_schema::ToolDefinition::parse(
            &tool.name,
            &tool.version,
            &serde_json::to_string(&tool.input_schema).map_err(|error| error.to_string())?,
            &serde_json::to_string(&tool.output_schema).map_err(|error| error.to_string())?,
            &serde_json::to_string(&tool.error_schema).map_err(|error| error.to_string())?,
            tool.effects.clone(),
            match tool.idempotency {
                josh_protocol::Idempotency::Unknown => allen_schema::Idempotency::Unknown,
                josh_protocol::Idempotency::Idempotent => allen_schema::Idempotency::Idempotent,
                josh_protocol::Idempotency::NonIdempotent => allen_schema::Idempotency::NonIdempotent,
            },
            &limits,
        ).map_err(|error| format!("tool {}: {error}", tool.name))
    }).collect::<Result<Vec<_>, _>>()?;
    allen_schema::FrozenCatalog::freeze_with_dialect(&params.schema_dialect, tools, &allen_schema::CatalogLimits::default())
        .map_err(|error| error.to_string())
}

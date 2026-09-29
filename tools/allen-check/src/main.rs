//! Catalog-aware ALLEN source checker for SHOUT skills.
//!
//! `allen check` compiles against an empty tool catalog. SHOUT lists and
//! validates skills against its frozen host tools without starting JOSH, and
//! needs the entry's source-level boundary type to build the entry input.
//!
//! Usage: `shout-allen-check <catalog.json>` with ALLEN source on stdin.
//! Prints one JSON object on stdout and exits 0 unless its own inputs are invalid.
//!
//! Compiler diagnostics come from `josh_host::compile_source_bundle`, the path
//! JOSH's `program/load` and `program/check` use, with the source loaded as
//! `src/main.allen`, so both report identical diagnostics. A successful check
//! also returns `debug`: the static control-flow construct and effect-site
//! tables that `program/load` returns, so construct and site IDs match the
//! `origin` of the program's provider requests.

use allen_bytecode::ValueType;
use allen_compiler::compile_inline_manifest_source_with_catalog;
use josh_host::{ProgramDebug, compile_source_bundle};
use josh_protocol::{CatalogSetParams, FileEncoding, SourceFile, Validate as _};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::Read as _;
use std::process::ExitCode;

const LIMIT: usize = 1024 * 1024;

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
    // The front end gives the manifest and the entry's source-level signature.
    let front = compile_inline_manifest_source_with_catalog(source, catalog).ok();
    let entry = front.as_ref().and_then(|(manifest, compilation, _)| {
        let name = manifest.as_ref().map_or("main", |manifest| manifest.entry.as_str());
        compilation.exported_functions.iter().find(|function| function.function == name)
    });
    let entry = entry.map(|function| json!({
        "name": function.function,
        "input": function.parameter_types.first().map_or(json!({ "type": "void" }), describe),
        "input_spelling": function.parameter_spellings.first(),
        "output": describe(&function.return_type),
        "output_spelling": function.return_spelling,
        "effects": function.effects,
    }));
    // Compile exactly as JOSH loads the skill, so diagnostics match program/load.
    let files = [SourceFile { path: "src/main.allen".to_owned(), encoding: FileEncoding::Utf8, content: source.to_owned() }];
    let package = match compile_source_bundle(&files, catalog, LIMIT as u64) {
        Ok(package) => package,
        Err(error) => {
            let diagnostics = if error.diagnostics.is_empty() {
                vec![json!({ "line": 1, "column": 1, "code": "SHOUT002", "message": error.error.message })]
            } else {
                error.diagnostics.iter().map(|diagnostic| json!(diagnostic)).collect()
            };
            return json!({ "ok": false, "entry": entry, "diagnostics": diagnostics });
        }
    };
    let Some((Some(manifest), _, _)) = front else {
        return json!({ "ok": false, "diagnostics": [{ "line": 1, "column": 1, "code": "SHOUT001",
            "message": "a skill must begin with an inline manifest { ... } block" }] });
    };
    json!({
        "ok": true,
        "diagnostics": [],
        "entry": entry,
        "capabilities": manifest.capabilities,
        "tools": manifest.tools.iter().map(|tool| tool.name.as_str().to_owned()).collect::<Vec<_>>(),
        "debug": debug_tables(source, &package.artifact),
    })
}

/// The `program/load` debug tables for this source loaded as `src/main.allen`.
fn debug_tables(source: &str, artifact: &allen_bytecode::Artifact) -> Value {
    let Some(debug) = &artifact.debug else {
        return Value::Null;
    };
    let tool_names = artifact.manifest.as_ref().map_or_else(Vec::new, |manifest| {
        manifest.required_tools.iter().map(|tool| tool.name.clone()).collect()
    });
    let texts = BTreeMap::from([("src/main.allen".to_owned(), source.to_owned())]);
    let tables = ProgramDebug::new(&artifact.module, debug, &tool_names, &texts).tables(usize::MAX);
    serde_json::to_value(tables).unwrap_or(Value::Null)
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

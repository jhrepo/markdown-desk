//! macOS Launch Services: set Markdown Desk as the default handler for .md files.
//! Uses LSSetDefaultRoleHandlerForContentType (deprecated since macOS 12, but still
//! functional as of macOS 15). No direct replacement exists; monitor future macOS releases.

#[cfg(target_os = "macos")]
use core_foundation::base::TCFType;
#[cfg(target_os = "macos")]
use core_foundation::string::{CFString, CFStringRef};

#[cfg(target_os = "macos")]
extern "C" {
    fn LSSetDefaultRoleHandlerForContentType(
        content_type: CFStringRef,
        role: u32,
        handler_bundle_id: CFStringRef,
    ) -> i32;

    fn LSCopyDefaultRoleHandlerForContentType(
        content_type: CFStringRef,
        role: u32,
    ) -> CFStringRef;
}

/// kLSRolesAll — handle all roles (viewer, editor, etc.)
#[cfg(target_os = "macos")]
const K_LS_ROLES_ALL: u32 = 0xFFFF_FFFF;

/// The canonical UTI for markdown files.
#[cfg(target_os = "macos")]
const MARKDOWN_UTI: &str = "net.daringfireball.markdown";

/// Check if the given bundle ID is the current default handler for markdown files.
#[cfg(target_os = "macos")]
pub fn is_default_md_handler(bundle_id: &str) -> bool {
    let cf_uti = CFString::new(MARKDOWN_UTI);
    let handler_ref = unsafe {
        LSCopyDefaultRoleHandlerForContentType(cf_uti.as_concrete_TypeRef(), K_LS_ROLES_ALL)
    };
    if handler_ref.is_null() {
        return false;
    }
    let handler = unsafe { CFString::wrap_under_create_rule(handler_ref) };
    handler.to_string().eq_ignore_ascii_case(bundle_id)
}

/// Register the given bundle ID as the default handler for markdown files.
#[cfg(target_os = "macos")]
pub fn set_as_default_md_handler(bundle_id: &str) -> Result<(), String> {
    let cf_uti = CFString::new(MARKDOWN_UTI);
    let bundle = CFString::new(bundle_id);
    let status = unsafe {
        LSSetDefaultRoleHandlerForContentType(
            cf_uti.as_concrete_TypeRef(),
            K_LS_ROLES_ALL,
            bundle.as_concrete_TypeRef(),
        )
    };
    if status != 0 {
        return Err(format!(
            "LSSetDefaultRoleHandlerForContentType failed: status {}",
            status
        ));
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn is_default_md_handler(_bundle_id: &str) -> bool {
    false
}

#[cfg(not(target_os = "macos"))]
pub fn set_as_default_md_handler(_bundle_id: &str) -> Result<(), String> {
    Err("Only supported on macOS".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(target_os = "macos")]
    fn is_default_handler_returns_bool() {
        // Should not panic; result depends on system state.
        let _ = is_default_md_handler("com.markdowndesk.app");
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn is_default_handler_false_for_invalid_bundle() {
        assert!(!is_default_md_handler("com.nonexistent.app.12345"));
    }
}

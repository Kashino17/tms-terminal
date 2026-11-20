Pod::Spec.new do |s|
  s.name           = 'TMSUsbRelay'
  s.version        = '1.0.0'
  s.summary        = 'usbmux relay for the DeX cable monitor (Fold as USB host)'
  s.description    = 'Collects usbmux streams the Fold opens to 127.0.0.1:8769 and splices them onto local clients of 127.0.0.1:8768.'
  s.author         = 'TMS Terminal'
  s.homepage       = 'https://github.com/Kashino17/tms-terminal'
  s.license        = 'UNLICENSED'
  s.platforms      = { :ios => '13.4' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files   = '**/*.swift'
  s.swift_version  = '5.4'
end
